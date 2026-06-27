import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import type { Adapter, Benchmark, PatchSubmission, Problem, RunnerJob, RunnerResult } from "../contracts/types.ts";
import { ContractViolation } from "../golden-trust-slice.ts";

export interface LocalPatchRunInput {
  benchmark: Benchmark;
  adapter: Adapter;
  problem: Problem;
  submission: PatchSubmission;
  patch: string;
  fixtureDir?: string;
  keepWorktree?: boolean;
  runLabel?: string;
}

export type SandboxMode = "local" | "docker";

export interface LocalPatchVerificationRun {
  job: RunnerJob;
  result: RunnerResult;
  worktree: string;
  stdout: string;
  stderr: string;
  sandboxMode: "local" | "docker";
}
export interface HiddenOracleCase {
  id: string;
  args: readonly unknown[];
  expected: unknown;
}

interface HiddenOracleOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type DiffChangeType = "add" | "modify" | "delete";

export interface ParsedFilePatch {
  path: string;
  oldPath: string | null;
  newPath: string | null;
  changeType: DiffChangeType;
  oldMode: string | null;
  newMode: string | null;
  isBinary: boolean;
  isSymlink: boolean;
  locAdded: number;
  locDeleted: number;
  hunks: ParsedHunk[];
}

export interface ParsedHunk {
  oldStart: number;
  newStart: number;
  oldCount: number;
  newCount: number;
  lines: string[];
}

interface MutableFilePatch {
  diffOldPath: string;
  diffNewPath: string;
  oldPath?: string | null;
  newPath?: string | null;
  oldMode: string | null;
  newMode: string | null;
  oldModeSource: string | null;
  newModeSource: string | null;
  declaredChangeType: DiffChangeType | null;
  isBinary: boolean;
  hunks: ParsedHunk[];
}

function patchViolation(code: string, message: string): ContractViolation {
  return new ContractViolation("patch application failed", [{ code, message }]);
}
function measuredRuntimeMs(startedAt: bigint): number {
  const elapsedNs = process.hrtime.bigint() - startedAt;
  const elapsedMs = Number(elapsedNs / 1_000_000n);
  return Math.max(1, elapsedMs);
}


const PATCH_FILE_MODES = new Set(["100644", "100755", "120000"]);

function setPatchMode(file: MutableFilePatch, side: "old" | "new", mode: string | null, source: string): void {
  const modeKey = side === "old" ? "oldMode" : "newMode";
  const sourceKey = side === "old" ? "oldModeSource" : "newModeSource";
  const existingSource = file[sourceKey];
  if (mode !== null && !PATCH_FILE_MODES.has(mode)) {
    throw patchViolation("patch.modeUnsupported", `Unsupported ${side} file mode ${mode} for ${file.diffNewPath}.`);
  }
  if (existingSource && file[modeKey] !== mode) {
    throw patchViolation("patch.modeConflict", `Conflicting ${side} file modes in patch metadata for ${file.diffNewPath}.`);
  }
  file[modeKey] = mode;
  file[sourceKey] = source;
}

function stableId(prefix: string, seed: string): string {
  return `${prefix}-${seed.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function runSeedFor(input: LocalPatchRunInput, suffix?: string): string {
  return [input.submission.id, sha256(input.patch), input.runLabel, suffix].filter(Boolean).join("-");
}


function defaultFixtureDir(problem: Problem): string {
  return join(process.cwd(), "fixtures", problem.id);
}

function canonicalPatchPath(target: string, source: string): string {
  const segments = target.split("/");
  if (!target || target.startsWith("/") || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw patchViolation("patch.target.invalid", `Patch target is not canonical: ${source}`);
  }
  return target;
}

function parseTargetPath(line: string, prefix: "a" | "b"): string | null {
  const raw = line.slice(4).trim().split(/\s+/)[0];
  if (!raw || raw === "/dev/null") return null;
  const expectedPrefix = `${prefix}/`;
  return canonicalPatchPath(raw.startsWith(expectedPrefix) ? raw.slice(expectedPrefix.length) : raw, raw);
}

function parseDiffPath(path: string): string {
  const target = path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
  return canonicalPatchPath(target, path);
}

function finalizeFilePatch(file: MutableFilePatch): ParsedFilePatch {
  const oldPath = file.oldPath === undefined ? parseDiffPath(file.diffOldPath) : file.oldPath;
  const newPath = file.newPath === undefined ? parseDiffPath(file.diffNewPath) : file.newPath;
  const diffOldPath = parseDiffPath(file.diffOldPath);
  const diffNewPath = parseDiffPath(file.diffNewPath);
  if (diffOldPath !== diffNewPath) {
    throw patchViolation("patch.renameUnsupported", `Rename or copy patches are not supported: ${diffOldPath} -> ${diffNewPath}`);
  }
  if (oldPath !== null && oldPath !== diffOldPath) {
    throw patchViolation("patch.target.mismatch", `Patch old target does not match diff header: ${oldPath}`);
  }
  if (newPath !== null && newPath !== diffNewPath) {
    throw patchViolation("patch.target.mismatch", `Patch new target does not match diff header: ${newPath}`);
  }
  if (oldPath !== null && newPath !== null && oldPath !== newPath) {
    throw patchViolation("patch.renameUnsupported", `Rename or copy patches are not supported: ${oldPath} -> ${newPath}`);
  }
  if (oldPath === null && newPath === null) {
    throw patchViolation("patch.target.mismatch", `Patch target cannot use /dev/null for both sides: ${file.diffNewPath}`);
  }
  if (file.declaredChangeType === "add" && (oldPath !== null || newPath === null)) {
    throw patchViolation("patch.target.mismatch", `New-file patch headers are inconsistent for ${file.diffNewPath}`);
  }
  if (file.declaredChangeType === "delete" && (oldPath === null || newPath !== null)) {
    throw patchViolation("patch.target.mismatch", `Deleted-file patch headers are inconsistent for ${file.diffOldPath}`);
  }
  const changeType: DiffChangeType =
    oldPath === null ? "add" : newPath === null ? "delete" : "modify";
  const path = changeType === "delete" ? oldPath ?? parseDiffPath(file.diffOldPath) : newPath ?? parseDiffPath(file.diffNewPath);
  const isSymlink = file.oldMode === "120000" || file.newMode === "120000";
  const locAdded = file.hunks.reduce(
    (sum, hunk) => sum + hunk.lines.filter((line) => line.startsWith("+")).length,
    0,
  );
  const locDeleted = file.hunks.reduce(
    (sum, hunk) => sum + hunk.lines.filter((line) => line.startsWith("-")).length,
    0,
  );

  return {
    path,
    oldPath,
    newPath,
    changeType,
    oldMode: file.oldMode,
    newMode: file.newMode,
    isBinary: file.isBinary,
    isSymlink,
    locAdded,
    locDeleted,
    hunks: file.hunks,
  };
}

export function parseUnifiedDiff(patch: string): ParsedFilePatch[] {
  const lines = patch.split(/\r?\n/);
  const files: MutableFilePatch[] = [];
  let current: MutableFilePatch | undefined;
  let currentHunk: ParsedHunk | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const diffMatch = /^diff --git (a\/\S+) (b\/\S+)$/.exec(line);
    if (diffMatch) {
      current = {
        diffOldPath: diffMatch[1],
        diffNewPath: diffMatch[2],
        oldPath: undefined,
        newPath: undefined,
        oldMode: "100644",
        newMode: "100644",
        oldModeSource: null,
        newModeSource: null,
        declaredChangeType: null,
        isBinary: false,
        hunks: [],
      };
      files.push(current);
      currentHunk = undefined;
      continue;
    }

    if (!current) {
      if (line.trim() === "") continue;
      throw patchViolation("patch.malformed", "Patch content must start with a diff --git file header.");
    }

    const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(line);
    if (hunkMatch) {
      if (current.oldPath === undefined || current.newPath === undefined) {
        throw patchViolation("patch.header.missing", `Patch target is missing ---/+++ headers for ${current.diffNewPath}.`);
      }
      const oldStart = Number(hunkMatch[1]);
      const newStart = Number(hunkMatch[3]);
      const oldCount = hunkMatch[2] === undefined ? (oldStart === 0 ? 0 : 1) : Number(hunkMatch[2]);
      const newCount = hunkMatch[4] === undefined ? (newStart === 0 ? 0 : 1) : Number(hunkMatch[4]);
      if ((oldStart === 0 && oldCount !== 0) || (newStart === 0 && newCount !== 0)) {
        throw patchViolation("patch.hunk.range", `Patch hunk zero ranges are malformed for ${current.newPath ?? current.oldPath}.`);
      }
      currentHunk = { oldStart, newStart, oldCount, newCount, lines: [] };
      current.hunks.push(currentHunk);
      continue;
    }

    if (currentHunk) {
      if (line === "") {
        if (index === lines.length - 1) continue;
        throw patchViolation("patch.hunk.malformed", `Malformed empty hunk line for ${current.newPath ?? current.oldPath}.`);
      }
      if (line.startsWith("\\")) {
        if (line === "\\ No newline at end of file") {
          throw patchViolation("patch.hunk.noNewlineUnsupported", `No-newline hunk markers are not supported for ${current.newPath ?? current.oldPath}.`);
        }
        throw patchViolation("patch.hunk.malformed", `Malformed hunk marker for ${current.newPath ?? current.oldPath}.`);
      }
      if (/^[ +-]/.test(line)) {
        currentHunk.lines.push(line);
        continue;
      }
      throw patchViolation("patch.hunk.malformed", `Malformed hunk line for ${current.newPath ?? current.oldPath}.`);
    }

    if (line.startsWith("@@")) {
      throw patchViolation("patch.hunk.malformed", `Malformed hunk header for ${current.newPath ?? current.oldPath}.`);
    }
    if (line.startsWith("index ")) {
      const indexMatch = /^index \S+\.\.\S+(?: (\d{6}))?$/.exec(line);
      if (!indexMatch) {
        throw patchViolation("patch.malformed", `Malformed patch index line for ${current.diffNewPath}.`);
      }
      if (indexMatch[1]) {
        setPatchMode(current, "old", indexMatch[1], "index");
        setPatchMode(current, "new", indexMatch[1], "index");
      }
      continue;
    }

    if (line.startsWith("old mode ")) {
      setPatchMode(current, "old", line.slice("old mode ".length).trim(), "old mode");
      continue;
    }
    if (line.startsWith("new mode ")) {
      setPatchMode(current, "new", line.slice("new mode ".length).trim(), "new mode");
      continue;
    }
    if (line.startsWith("new file mode ")) {
      if (current.declaredChangeType && current.declaredChangeType !== "add") {
        throw patchViolation("patch.target.mismatch", `Contradictory file operation metadata for ${current.diffNewPath}.`);
      }
      current.declaredChangeType = "add";
      current.oldPath = null;
      setPatchMode(current, "old", null, "new file mode");
      setPatchMode(current, "new", line.slice("new file mode ".length).trim(), "new file mode");
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      if (current.declaredChangeType && current.declaredChangeType !== "delete") {
        throw patchViolation("patch.target.mismatch", `Contradictory file operation metadata for ${current.diffNewPath}.`);
      }
      current.declaredChangeType = "delete";
      current.newPath = null;
      setPatchMode(current, "new", null, "deleted file mode");
      setPatchMode(current, "old", line.slice("deleted file mode ".length).trim(), "deleted file mode");
      continue;
    }
    if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      throw patchViolation("patch.binary", `Binary patches are not supported: ${current.diffNewPath}.`);
    }
    if (line.startsWith("--- ")) {
      current.oldPath = parseTargetPath(line, "a");
      continue;
    }
    if (line.startsWith("+++ ")) {
      current.newPath = parseTargetPath(line, "b");
      continue;
    }
    if (line.trim() !== "") {
      throw patchViolation("patch.malformed", `Unexpected patch metadata line for ${current.newPath ?? current.oldPath}.`);
    }
  }

  const parsed = files.map(finalizeFilePatch).filter((file) => file.isBinary || file.hunks.length > 0 || file.oldMode !== file.newMode);
  if (parsed.length === 0) {
    throw patchViolation("patch.empty", "Patch must contain at least one unified-diff file hunk.");
  }

  const seen = new Set<string>();
  for (const file of parsed) {
    if (seen.has(file.path)) {
      throw patchViolation("patch.target.duplicate", `Patch target appears more than once: ${file.path}`);
    }
    seen.add(file.path);
    for (const hunk of file.hunks) validateHunkCounts(file, hunk);
  }

  const sortedTargets = parsed.map((file) => file.path).sort();
  for (let index = 1; index < sortedTargets.length; index += 1) {
    const previous = sortedTargets[index - 1];
    const currentTarget = sortedTargets[index];
    if (currentTarget.startsWith(`${previous}/`)) {
      throw patchViolation("patch.target.conflict", `Patch targets have an ancestor conflict: ${previous} and ${currentTarget}`);
    }
  }

  return parsed;
}

export function assertPatchTargetsAllowed(problem: Problem, patch: string): ParsedFilePatch[] {
  const allowedPaths = new Set(problem.editableFilePaths);
  const parsed = parseUnifiedDiff(patch);
  for (const filePatch of parsed) {
    if (!allowedPaths.has(filePatch.path)) {
      throw patchViolation("patch.target.notEditable", `Patch target is not editable for ${problem.id}: ${filePatch.path}`);
    }
  }
  return parsed;
}

function assertInsideWorktree(root: string, filePath: string): string {
  const absolutePath = resolve(root, filePath);
  const rootPath = resolve(root);
  if (absolutePath !== rootPath && !absolutePath.startsWith(`${rootPath}${sep}`)) {
    throw patchViolation("patch.target.outsideWorktree", `Patch target escapes worktree: ${filePath}`);
  }
  return absolutePath;
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function assertNoSymlinkPath(root: string, absolutePath: string, filePath: string): void {
  const rootPath = resolve(root);
  const relativePath = absolutePath === rootPath ? "" : absolutePath.slice(rootPath.length + 1);
  let currentPath = rootPath;
  const parts = relativePath.split(sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    currentPath = join(currentPath, parts[index]);
    const stat = lstatIfPresent(currentPath);
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      throw patchViolation("patch.target.symlink", `Patch target traverses a symlink path: ${filePath}`);
    }
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw patchViolation("patch.target.parent", `Patch target parent is not a directory: ${filePath}`);
    }
  }
}

function splitFileContent(content: string): string[] {
  if (content.length === 0) return [];
  return content.replace(/\n$/, "").split("\n");
}

interface FilePatchOperation {
  absolutePath: string;
  content: string | null;
}

const NORMAL_FILE_MODES = new Set(["100644", "100755"]);

function validateHunkCounts(filePatch: ParsedFilePatch, hunk: ParsedHunk): void {
  if (hunk.oldCount === 0 && hunk.newCount === 0 && hunk.lines.length === 0) {
    throw patchViolation("patch.hunk.empty", `Patch hunk is empty for ${filePatch.path}`);
  }
  const oldLineCount = hunk.lines.filter((line) => line.startsWith(" ") || line.startsWith("-")).length;
  const newLineCount = hunk.lines.filter((line) => line.startsWith(" ") || line.startsWith("+")).length;
  if (oldLineCount !== hunk.oldCount || newLineCount !== hunk.newCount) {
    throw patchViolation("patch.hunk.countMismatch", `Patch hunk line counts do not match header for ${filePatch.path}`);
  }
}

function buildFilePatchOperation(root: string, filePatch: ParsedFilePatch): FilePatchOperation {
  const absolutePath = assertInsideWorktree(root, filePatch.path);
  assertNoSymlinkPath(root, absolutePath, filePatch.path);

  if (filePatch.isBinary) {
    throw patchViolation("patch.binary", `Binary patches are not supported: ${filePatch.path}`);
  }
  if (filePatch.isSymlink) {
    throw patchViolation("patch.symlink", `Symlink patches are not supported: ${filePatch.path}`);
  }
  if (filePatch.oldMode && !NORMAL_FILE_MODES.has(filePatch.oldMode)) {
    throw patchViolation("patch.modeUnsupported", `Unsupported old file mode ${filePatch.oldMode} for ${filePatch.path}`);
  }
  if (filePatch.newMode && !NORMAL_FILE_MODES.has(filePatch.newMode)) {
    throw patchViolation("patch.modeUnsupported", `Unsupported new file mode ${filePatch.newMode} for ${filePatch.path}`);
  }
  if (filePatch.changeType === "add" && filePatch.newMode === "100755") {
    throw patchViolation("patch.modeUnsupported", `Executable add patches are not supported: ${filePatch.path}`);
  }
  if (filePatch.changeType === "modify" && filePatch.oldMode !== filePatch.newMode) {
    throw patchViolation("patch.modeChange", `Mode-only or mode-changing patches are not supported: ${filePatch.path}`);
  }
  if (filePatch.hunks.length === 0) {
    throw patchViolation("patch.empty", `Patch target has no hunks: ${filePatch.path}`);
  }
  if (filePatch.changeType === "add" && existsSync(absolutePath)) {
    throw patchViolation("patch.target.exists", `Patch target already exists: ${filePatch.path}`);
  }
  if (filePatch.changeType !== "add" && !existsSync(absolutePath)) {
    throw patchViolation("patch.target.missing", `Patch target does not exist: ${filePatch.path}`);
  }

  const original = filePatch.changeType === "add" ? "" : readFileSync(absolutePath, "utf8");
  const hadTrailingNewline = filePatch.changeType === "add" ? true : original.endsWith("\n");
  const source = splitFileContent(original);
  const output: string[] = [];
  let cursor = 0;

  for (const hunk of filePatch.hunks) {
    validateHunkCounts(filePatch, hunk);
    const hunkStart = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    if (hunkStart < cursor) {
      throw patchViolation("patch.hunk.overlap", `Patch hunks overlap for ${filePatch.path}`);
    }
    if (hunkStart > source.length) {
      throw patchViolation("patch.hunk.range", `Patch hunk starts outside source for ${filePatch.path}`);
    }
    output.push(...source.slice(cursor, hunkStart));
    const projectedNewStart = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
    if (projectedNewStart !== output.length) {
      throw patchViolation("patch.hunk.range", `Patch hunk new range does not match projected output for ${filePatch.path}`);
    }
    cursor = hunkStart;

    for (const hunkLine of hunk.lines) {
      const marker = hunkLine[0] ?? "";
      const text = hunkLine.slice(1);
      if (marker === " ") {
        if (source[cursor] !== text) {
          throw patchViolation("patch.context.mismatch", `Patch context mismatch in ${filePatch.path}`);
        }
        output.push(text);
        cursor += 1;
      } else if (marker === "-") {
        if (source[cursor] !== text) {
          throw patchViolation("patch.delete.mismatch", `Patch delete mismatch in ${filePatch.path}`);
        }
        cursor += 1;
      } else if (marker === "+") {
        output.push(text);
      } else {
        throw patchViolation("patch.hunk.malformed", `Malformed hunk line for ${filePatch.path}`);
      }
    }
  }

  output.push(...source.slice(cursor));

  if (filePatch.changeType === "delete") {
    if (output.length > 0) {
      throw patchViolation("patch.delete.incomplete", `Delete patch left content in ${filePatch.path}`);
    }
    return { absolutePath, content: null };
  }

  return { absolutePath, content: `${output.join("\n")}${hadTrailingNewline ? "\n" : ""}` };
}

export function applyUnifiedDiff(root: string, patch: string): void {
  const filePatches = parseUnifiedDiff(patch);
  const operations = filePatches.map((filePatch) => buildFilePatchOperation(root, filePatch));
  for (const operation of operations) {
    if (operation.content === null) {
      rmSync(operation.absolutePath, { force: true });
      continue;
    }
    mkdirSync(dirname(operation.absolutePath), { recursive: true });
    writeFileSync(operation.absolutePath, operation.content, "utf8");
  }
}

export function isPinnedDockerImageDigest(image: string): boolean {
  return /^[a-z0-9][a-z0-9._/-]*(?::[a-zA-Z0-9._-]+)?@sha256:[a-f0-9]{64}$/.test(image);
}

function minimalRunnerEnv(worktree: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    PYTHONPATH: worktree,
  };
}

function isDockerInfrastructureFailure(stderr: string): boolean {
  return /OCI runtime error|container create failed|PermissionError:.*\/work\/tests|failed to (pull|create|start)|cannot connect to the Docker daemon/i.test(stderr);
}

interface PrivateOracleDescriptor {
  problemId: string;
  cases: HiddenOracleCase[];
}

function rawPrivateOracleDescriptorText(): string {
  const inline = process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON;
  if (inline && inline.trim().length > 0) return inline;
  const descriptorPath = process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_PATH;
  if (descriptorPath && descriptorPath.trim().length > 0) return readFileSync(descriptorPath, "utf8");
  throw new ContractViolation("private oracle descriptor missing", [
    {
      code: "runner.privateOracle.required",
      message: "Scored hidden-oracle execution requires AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON or AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_PATH.",
    },
  ]);
}

function canonicalPrivateOracleDescriptor(problemId: string, value: unknown): string | null {
  const descriptor = value as { problemId?: unknown; cases?: unknown };
  if (descriptor?.problemId !== undefined && descriptor.problemId !== problemId) return null;
  if (!Array.isArray(descriptor?.cases) || descriptor.cases.length === 0) return null;
  return JSON.stringify({ problemId, cases: descriptor.cases });
}

function privateOracleDescriptorText(problem: Problem): string {
  const raw = rawPrivateOracleDescriptorText();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ContractViolation("private oracle descriptor invalid", [
      { code: "runner.privateOracle.invalidJson", message: "Private oracle descriptor must be valid JSON." },
    ]);
  }

  const direct = canonicalPrivateOracleDescriptor(problem.id, parsed);
  if (direct) return direct;

  const bundle = parsed as { descriptors?: unknown; problems?: unknown };
  if (Array.isArray(bundle.descriptors)) {
    for (const entry of bundle.descriptors) {
      const selected = canonicalPrivateOracleDescriptor(problem.id, entry);
      if (selected) return selected;
    }
  }
  if (bundle.problems && typeof bundle.problems === "object" && !Array.isArray(bundle.problems)) {
    const selected = (bundle.problems as Record<string, unknown>)[problem.id];
    if (selected !== undefined) {
      const canonical = canonicalPrivateOracleDescriptor(problem.id, selected);
      if (canonical) return canonical;
    }
  }

  throw new ContractViolation("private oracle descriptor invalid", [
    { code: "runner.privateOracle.invalidShape", message: "Private oracle descriptor must target the problem and include non-empty cases." },
  ]);
}

function assertScoredHiddenOracleProblem(problem: Problem): string {
  const oracle = problem.oracleMetadata;
  if (
    problem.scoringMode !== "scored-hidden" ||
    !oracle ||
    oracle.hiddenRequired !== true ||
    !/^sha256:[0-9a-f]{64}$/i.test(oracle.oracleDescriptorHash) ||
    !oracle.originalEvidenceId ||
    !oracle.rerunEvidenceId ||
    oracle.originalEvidenceId === oracle.rerunEvidenceId
  ) {
    throw new ContractViolation("private oracle metadata missing", [
      {
        code: "runner.privateOracle.metadataRequired",
        message: "Scored hidden-oracle execution requires scored-hidden problem metadata with distinct private evidence ids.",
      },
    ]);
  }
  return oracle.oracleDescriptorHash;
}

function parsePrivateOracleDescriptor(problem: Problem): HiddenOracleCase[] {
  const expectedHash = assertScoredHiddenOracleProblem(problem);
  const descriptorText = privateOracleDescriptorText(problem);
  const actualHash = `sha256:${sha256(descriptorText)}`;
  if (actualHash !== expectedHash) {
    throw new ContractViolation("private oracle descriptor mismatch", [
      { code: "runner.privateOracle.hashMismatch", message: "Private oracle descriptor hash does not match problem metadata." },
    ]);
  }

  let descriptor: PrivateOracleDescriptor;
  try {
    descriptor = JSON.parse(descriptorText) as PrivateOracleDescriptor;
  } catch {
    throw new ContractViolation("private oracle descriptor invalid", [
      { code: "runner.privateOracle.invalidJson", message: "Private oracle descriptor must be valid JSON." },
    ]);
  }

  if (
    descriptor.problemId !== problem.id ||
    !Array.isArray(descriptor.cases) ||
    descriptor.cases.length === 0 ||
    !descriptor.cases.every((testCase) => typeof testCase.id === "string" && testCase.id.trim().length > 0 && Array.isArray(testCase.args))
  ) {
    throw new ContractViolation("private oracle descriptor invalid", [
      { code: "runner.privateOracle.invalidShape", message: "Private oracle descriptor must target the problem and include non-empty cases." },
    ]);
  }
  return descriptor.cases;
}

function hiddenOracleCases(problem: Problem): HiddenOracleCase[] {
  return parsePrivateOracleDescriptor(problem);
}

function solutionHarnessSource(): string {
  return [
    "import importlib.util, json, pathlib, sys",
    "payload = json.loads(sys.argv[1])",
    "solution_path = pathlib.Path('/solution/solution.py' if pathlib.Path('/solution/solution.py').exists() else sys.argv[2])",
    "spec = importlib.util.spec_from_file_location('submitted_solution', solution_path)",
    "module = importlib.util.module_from_spec(spec)",
    "assert spec and spec.loader",
    "spec.loader.exec_module(module)",
    "result = module.candidate(*payload['args'])",
    "sys.stdout.write(json.dumps({'result': result}, sort_keys=True, separators=(',', ':')))",
  ].join("\n");
}

function hiddenOraclePayload(testCase: HiddenOracleCase): string {
  return JSON.stringify({ args: testCase.args });
}

function runLocalHiddenOracleCase(solutionPath: string, testCase: HiddenOracleCase, timeoutMs: number): HiddenOracleOutcome {
  const completed = spawnSync("python3", ["-I", "-c", solutionHarnessSource(), hiddenOraclePayload(testCase), solutionPath], {
    encoding: "utf8",
    timeout: timeoutMs,
    env: { PATH: process.env.PATH ?? "" },
  });
  return {
    exitCode: completed.status ?? (completed.error ? 1 : 0),
    stdout: completed.stdout ?? "",
    stderr: `${completed.stderr ?? ""}${completed.error ? completed.error.message : ""}`,
    timedOut: (completed.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
  };
}

function evaluateHiddenOracleOutcome(outcome: HiddenOracleOutcome, testCase: HiddenOracleCase): string | null {
  if (outcome.timedOut) return `hidden oracle timed out for ${testCase.id}`;
  if (outcome.exitCode !== 0) return `hidden oracle subprocess failed for ${testCase.id}`;
  try {
    const decoded = JSON.parse(outcome.stdout) as { result?: unknown };
    if (JSON.stringify(decoded.result) !== JSON.stringify(testCase.expected)) {
      return `hidden oracle mismatch for ${testCase.id}`;
    }
    return null;
  } catch {
    return `hidden oracle emitted invalid JSON for ${testCase.id}`;
  }
}

function runLocalHiddenOracle(input: LocalPatchRunInput, worktree: string): HiddenOracleOutcome {
  const cases = hiddenOracleCases(input.problem);
  const timeoutMs = input.adapter.defaultResources.timeoutSeconds * 1000;
  const solutionPath = join(worktree, "solution.py");
  const lines: string[] = [];
  for (const testCase of cases) {
    const outcome = runLocalHiddenOracleCase(solutionPath, testCase, timeoutMs);
    const failure = evaluateHiddenOracleOutcome(outcome, testCase);
    if (failure) {
      return {
        exitCode: outcome.timedOut ? 124 : 1,
        stdout: lines.join("\n"),
        stderr: failure,
        timedOut: outcome.timedOut,
      };
    }
    lines.push(`hidden-oracle:${testCase.id}:pass`);
  }
  return { exitCode: 0, stdout: lines.join("\n"), stderr: "", timedOut: false };
}

function dockerContainerName(input: LocalPatchRunInput, runSeed: string, caseId: string): string {
  return stableId("agentoj", `${input.problem.id}-${input.submission.id}-${runSeed}-${caseId}`).slice(0, 63);
}


export function dockerHiddenOracleRunArgs(
  input: LocalPatchRunInput,
  solutionPath: string,
  testCase: HiddenOracleCase,
  containerName: string,
): string[] {
  if (!isPinnedDockerImageDigest(input.adapter.dockerImageDigest)) {
    throw new ContractViolation("docker image must be digest-pinned", [
      { code: "runner.dockerDigest.required", message: "Docker sandbox requires image@sha256:<digest>." },
    ]);
  }
  const memory = `${Math.max(32, Math.trunc(input.adapter.defaultResources.memoryMb))}m`;
  return [
    "run",
    "--rm",
    "--name",
    containerName,
    "--network",
    "none",
    "--user",
    "65534:65534",
    "--cpus",
    String(input.adapter.defaultResources.cpuCores),
    "--memory",
    memory,
    "--memory-swap",
    memory,
    "--pids-limit",
    "128",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--tmpfs",
    "/run:rw,noexec,nosuid,size=8m",
    "-v",
    `${solutionPath}:/solution/solution.py:ro,z`,
    "-w",
    "/solution",
    "--env",
    "PYTHONPATH=/solution",
    "--env",
    "PYTHONDONTWRITEBYTECODE=1",
    input.adapter.dockerImageDigest,
    "python3",
    "-I",
    "-c",
    solutionHarnessSource(),
    hiddenOraclePayload(testCase),
    "/solution/solution.py",
  ];
}

export function dockerRunArgs(input: LocalPatchRunInput, worktree: string): string[] {
  const [firstCase] = hiddenOracleCases(input.problem);
  return dockerHiddenOracleRunArgs(
    input,
    join(worktree, "solution.py"),
    firstCase,
    dockerContainerName(input, sha256(input.patch), firstCase.id),
  );
}

function scoringStatusFor(input: LocalPatchRunInput): RunnerJob["scoringStatus"] {
  return input.problem.scoringMode === "scored-hidden" ? "scored" : "demo";
}

function oracleDescriptorHashFor(input: LocalPatchRunInput): string | null {
  return input.problem.scoringMode === "scored-hidden" ? (input.problem.oracleMetadata?.oracleDescriptorHash ?? null) : null;
}

export function runLocalPatchVerification(input: LocalPatchRunInput): LocalPatchVerificationRun {
  const fixture = input.fixtureDir ?? defaultFixtureDir(input.problem);
  if (!existsSync(fixture)) {
    throw new ContractViolation("fixture missing", [
      { code: "runner.fixture.missing", message: `Missing fixture directory for ${input.problem.id}.` },
    ]);
  }

  const runSeed = runSeedFor(input);
  const worktree = mkdtempSync(join(tmpdir(), `agentoj-${input.problem.id}-`));
  cpSync(fixture, worktree, { recursive: true });

  let patchApplyStatus: RunnerResult["patchApplyStatus"] = "clean";
  let exitCode = 1;
  let stdout = "";
  let stderr = "";
  let timedOut = false;

  const startedAt = process.hrtime.bigint();

  try {
    assertPatchTargetsAllowed(input.problem, input.patch);
    applyUnifiedDiff(worktree, input.patch);
    const [command, ...args] = input.adapter.judgeCommand;
    const completed = spawnSync(command, args, {
      cwd: worktree,
      encoding: "utf8",
      timeout: input.adapter.defaultResources.timeoutSeconds * 1000,
      env: minimalRunnerEnv(worktree),
    });
    stdout = completed.stdout ?? "";
    stderr = completed.stderr ?? "";
    exitCode = completed.status ?? (completed.error ? 1 : 0);
    if (completed.error) stderr = `${stderr}${completed.error.message}`;
    timedOut = (completed.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  } catch (error) {
    patchApplyStatus = "failed";
    stderr =
      error instanceof ContractViolation
        ? `${error.message}: ${error.issues.map((issue) => issue.message).join("; ")}`
        : error instanceof Error
          ? error.message
          : String(error);
  }

  const passed = patchApplyStatus === "clean" && exitCode === 0 && !timedOut;
  const job: RunnerJob = {
    id: stableId("job", runSeed),
    submissionId: input.submission.id,
    adapterId: input.adapter.id,
    upstreamCommit: input.benchmark.upstreamCommitOrVersion,
    dockerImageDigest: input.adapter.dockerImageDigest,
    resources: input.adapter.defaultResources,
    status: timedOut ? "timed-out" : passed ? "passed" : "failed",
    scoringStatus: scoringStatusFor(input),
    sandboxMode: "local",
    oracleDescriptorHash: oracleDescriptorHashFor(input),
  };
  const result: RunnerResult = {
    id: stableId("result", runSeed),
    jobId: job.id,
    patchApplyStatus,
    exitCode,
    passFail: passed ? "pass" : "fail",
    runtimeMs: measuredRuntimeMs(startedAt),
    memoryPeakMb: null,

    stdoutRef: `stdout:${sha256(stdout)}`,
    stderrRef: `stderr:${sha256(stderr)}`,
    resultHash: `result:${sha256(`${job.id}:${patchApplyStatus}:${exitCode}:${stdout}:${stderr}`)}`,
  };

  if (!input.keepWorktree) rmSync(worktree, { recursive: true, force: true });
  return { job, result, worktree, stdout, stderr, sandboxMode: "local" };
}

function assertUnsafeLocalHiddenOracleEnabled(): void {
  if (process.env.AGENTOJ_ALLOW_UNSAFE_LOCAL_HIDDEN_ORACLE === "1") return;
  throw new ContractViolation("unsafe local hidden oracle disabled", [
    {
      code: "runner.hiddenOracle.localDisabled",
      message: "Local hidden-oracle execution is disabled by default; use the Docker sandbox for scored private judging.",
    },
  ]);
}

export function runHiddenOraclePatchVerification(input: LocalPatchRunInput): LocalPatchVerificationRun {
  const fixture = input.fixtureDir ?? defaultFixtureDir(input.problem);
  if (!existsSync(fixture)) {
    throw new ContractViolation("fixture missing", [
      { code: "runner.fixture.missing", message: `Missing fixture directory for ${input.problem.id}.` },
    ]);
  }

  const runSeed = runSeedFor(input, "hidden-oracle");
  const worktree = mkdtempSync(join(tmpdir(), `agentoj-${input.problem.id}-hidden-`));
  cpSync(fixture, worktree, { recursive: true });

  let patchApplyStatus: RunnerResult["patchApplyStatus"] = "clean";
  let exitCode = 1;
  let stdout = "";
  let stderr = "";
  let timedOut = false;

  const startedAt = process.hrtime.bigint();

  try {
    assertUnsafeLocalHiddenOracleEnabled();
    assertPatchTargetsAllowed(input.problem, input.patch);
    applyUnifiedDiff(worktree, input.patch);
    rmSync(join(worktree, "tests"), { recursive: true, force: true });
    const outcome = runLocalHiddenOracle(input, worktree);
    exitCode = outcome.exitCode;
    stdout = outcome.stdout;
    stderr = outcome.stderr;
    timedOut = outcome.timedOut;
  } catch (error) {
    patchApplyStatus = "failed";
    stderr =
      error instanceof ContractViolation
        ? `${error.message}: ${error.issues.map((issue) => issue.message).join("; ")}`
        : error instanceof Error
          ? error.message
          : String(error);
  }

  const passed = patchApplyStatus === "clean" && exitCode === 0 && !timedOut;
  const job: RunnerJob = {
    id: stableId("job", runSeed),
    submissionId: input.submission.id,
    adapterId: input.adapter.id,
    upstreamCommit: input.benchmark.upstreamCommitOrVersion,
    dockerImageDigest: input.adapter.dockerImageDigest,
    resources: input.adapter.defaultResources,
    status: timedOut ? "timed-out" : passed ? "passed" : "failed",
    scoringStatus: scoringStatusFor(input),
    sandboxMode: "local",
    oracleDescriptorHash: oracleDescriptorHashFor(input),
  };
  const result: RunnerResult = {
    id: stableId("result", runSeed),
    jobId: job.id,
    patchApplyStatus,
    exitCode,
    passFail: passed ? "pass" : "fail",
    runtimeMs: measuredRuntimeMs(startedAt),
    memoryPeakMb: null,
    stdoutRef: `stdout:${sha256(stdout)}`,
    stderrRef: `stderr:${sha256(stderr)}`,
    resultHash: `result:${sha256(`${job.id}:${patchApplyStatus}:${exitCode}:${stdout}:${stderr}`)}`,
  };

  if (!input.keepWorktree) rmSync(worktree, { recursive: true, force: true });
  return { job, result, worktree, stdout, stderr, sandboxMode: "local" };
}

export function dockerAvailable(): boolean {
  const probe = spawnSync("docker", ["--version"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  return probe.status === 0;
}

export function runDockerPatchVerification(input: LocalPatchRunInput): LocalPatchVerificationRun {
  if (!isPinnedDockerImageDigest(input.adapter.dockerImageDigest)) {
    throw new ContractViolation("docker image must be digest-pinned", [
      { code: "runner.dockerDigest.required", message: "Docker sandbox requires image@sha256:<digest>." },
    ]);
  }
  try {
    assertPatchTargetsAllowed(input.problem, input.patch);
  } catch (error) {

    const startedAt = process.hrtime.bigint();

    const runSeed = runSeedFor(input, "docker-rejected");
    const stderr =
      error instanceof ContractViolation
        ? `${error.message}: ${error.issues.map((issue) => issue.message).join("; ")}`
        : error instanceof Error
          ? error.message
          : String(error);
    const job: RunnerJob = {
      id: stableId("job", runSeed),
      submissionId: input.submission.id,
      adapterId: input.adapter.id,
      upstreamCommit: input.benchmark.upstreamCommitOrVersion,
      dockerImageDigest: input.adapter.dockerImageDigest,
      resources: input.adapter.defaultResources,
      status: "failed",
      scoringStatus: scoringStatusFor(input),
      sandboxMode: "docker",
      oracleDescriptorHash: oracleDescriptorHashFor(input),
    };
    const result: RunnerResult = {
      id: stableId("result", runSeed),
      jobId: job.id,
      patchApplyStatus: "failed",
      exitCode: 1,
      passFail: "fail",
      runtimeMs: measuredRuntimeMs(startedAt),
      memoryPeakMb: null,

      stdoutRef: `stdout:${sha256("")}`,
      stderrRef: `stderr:${sha256(stderr)}`,
      resultHash: `result:${sha256(`${job.id}:patch-rejected:${stderr}`)}`,
    };
    return { job, result, worktree: "", stdout: "", stderr, sandboxMode: "docker" };
  }
  hiddenOracleCases(input.problem);
  if (!dockerAvailable()) {
    const startedAt = process.hrtime.bigint();

    const runSeed = runSeedFor(input, "docker-unavailable");
    const job: RunnerJob = {
      id: stableId("job", runSeed),
      submissionId: input.submission.id,
      adapterId: input.adapter.id,
      upstreamCommit: input.benchmark.upstreamCommitOrVersion,
      dockerImageDigest: input.adapter.dockerImageDigest,
      resources: input.adapter.defaultResources,
      status: "infra-error",
      scoringStatus: scoringStatusFor(input),
      sandboxMode: "docker",
      oracleDescriptorHash: oracleDescriptorHashFor(input),
    };
    const stderr = "Docker unavailable; docker sandbox execution did not run.";
    const result: RunnerResult = {
      id: stableId("result", runSeed),
      jobId: job.id,
      patchApplyStatus: "failed",
      exitCode: 1,
      passFail: "fail",
      runtimeMs: measuredRuntimeMs(startedAt),
      memoryPeakMb: null,

      stdoutRef: `stdout:${sha256("")}`,
      stderrRef: `stderr:${sha256(stderr)}`,
      resultHash: `result:${sha256(`${job.id}:docker-unavailable:${stderr}`)}`,
    };
    return { job, result, worktree: "", stdout: "", stderr, sandboxMode: "docker" };
  }

  const fixture = input.fixtureDir ?? defaultFixtureDir(input.problem);
  if (!existsSync(fixture)) {
    throw new ContractViolation("fixture missing", [
      { code: "runner.fixture.missing", message: `Missing fixture directory for ${input.problem.id}.` },
    ]);
  }

  const runSeed = runSeedFor(input, "docker");
  const worktree = mkdtempSync(join(tmpdir(), `agentoj-${input.problem.id}-docker-`));
  cpSync(fixture, worktree, { recursive: true });

  let patchApplyStatus: RunnerResult["patchApplyStatus"] = "clean";
  let exitCode = 1;
  let stdout = "";
  let stderr = "";
  let timedOut = false;

  const startedAt = process.hrtime.bigint();

  try {
    applyUnifiedDiff(worktree, input.patch);
    const cases = hiddenOracleCases(input.problem);
    const solutionPath = join(worktree, "solution.py");
    const timeoutMs = input.adapter.defaultResources.timeoutSeconds * 1000;
    const outputLines: string[] = [];
    for (const testCase of cases) {
      const containerName = dockerContainerName(input, runSeed, testCase.id);
      const completed = spawnSync("docker", dockerHiddenOracleRunArgs(input, solutionPath, testCase, containerName), {
        encoding: "utf8",
        timeout: timeoutMs,
        env: { PATH: process.env.PATH ?? "" },
      });
      const caseStdout = completed.stdout ?? "";
      const caseStderr = `${completed.stderr ?? ""}${completed.error ? completed.error.message : ""}`;
      const caseTimedOut = (completed.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
      const cleanup = spawnSync("docker", ["rm", "-f", containerName], {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "" },
      });
      outputLines.push(`hidden-oracle:${testCase.id}:container=${containerName}:cleanup=${cleanup.status === 0 || cleanup.status === 1 ? "done" : "unknown"}`);
      const failure = evaluateHiddenOracleOutcome(
        { exitCode: completed.status ?? (completed.error ? 1 : 0), stdout: caseStdout, stderr: caseStderr, timedOut: caseTimedOut },
        testCase,
      );
      if (failure) {
        exitCode = caseTimedOut ? 124 : 1;
        stdout = outputLines.join("\n");
        stderr = caseStderr || failure;
        timedOut = caseTimedOut;
        break;
      }
      exitCode = 0;
    }
    if (exitCode === 0) stdout = outputLines.join("\n");
  } catch (error) {
    patchApplyStatus = "failed";
    stderr =
      error instanceof ContractViolation
        ? `${error.message}: ${error.issues.map((issue) => issue.message).join("; ")}`
        : error instanceof Error
          ? error.message
          : String(error);
  }

  const passed = patchApplyStatus === "clean" && exitCode === 0 && !timedOut;
  const infrastructureFailure = patchApplyStatus === "clean" && !passed && isDockerInfrastructureFailure(stderr);
  const job: RunnerJob = {
    id: stableId("job", runSeed),
    submissionId: input.submission.id,
    adapterId: input.adapter.id,
    upstreamCommit: input.benchmark.upstreamCommitOrVersion,
    dockerImageDigest: input.adapter.dockerImageDigest,
    resources: input.adapter.defaultResources,
    status: timedOut ? "timed-out" : infrastructureFailure ? "infra-error" : passed ? "passed" : "failed",
    scoringStatus: scoringStatusFor(input),
    sandboxMode: "docker",
    oracleDescriptorHash: oracleDescriptorHashFor(input),
  };
  const result: RunnerResult = {
    id: stableId("result", runSeed),
    jobId: job.id,
    patchApplyStatus,
    exitCode,
    passFail: passed ? "pass" : "fail",
    runtimeMs: measuredRuntimeMs(startedAt),
    memoryPeakMb: null,
    stdoutRef: `stdout:${sha256(stdout)}`,
    stderrRef: `stderr:${sha256(stderr)}`,
    resultHash: `result:${sha256(`${job.id}:${patchApplyStatus}:${exitCode}:${stdout}:${stderr}`)}`,
  };

  if (!input.keepWorktree) rmSync(worktree, { recursive: true, force: true });
  return { job, result, worktree, stdout, stderr, sandboxMode: "docker" };
}

export function runPatchVerification(input: LocalPatchRunInput, sandboxMode: SandboxMode = "local"): LocalPatchVerificationRun {
  return sandboxMode === "docker" ? runDockerPatchVerification(input) : runLocalPatchVerification(input);
}
