import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import type { Adapter, Benchmark, PatchSubmission, PrivateOracleDescriptor, PrivateOracleEvidencePolicy, Problem, RunnerJob, RunnerResult } from "../contracts/types.ts";
import { selectCanonicalPrivateOracleDescriptor, validatePrivateOracleDescriptor } from "../contracts/validators.ts";
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
  oracleStarted?: boolean;
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

function canGeneratePublicStarter(problem: Problem): boolean {
  return (
    ((problem.benchmarkId === "humaneval" && problem.id.startsWith("humaneval-full-") && problem.upstreamTaskId.startsWith("HumanEval/")) ||
      (problem.benchmarkId === "mbpp" && problem.id.startsWith("mbpp-full-") && problem.upstreamTaskId.startsWith("MBPP/"))) &&
    problem.editableFilePaths.length === 1 &&
    problem.editableFilePaths[0] === "solution.py"
  );
}

function createFixtureWorktree(input: LocalPatchRunInput, prefix: string): string {
  const fixture = input.fixtureDir ?? defaultFixtureDir(input.problem);
  const worktree = mkdtempSync(join(tmpdir(), prefix));
  if (existsSync(fixture)) {
    cpSync(fixture, worktree, { recursive: true });
    return worktree;
  }
  if (input.fixtureDir === undefined && canGeneratePublicStarter(input.problem)) {
    writeFileSync(join(worktree, "solution.py"), "", "utf8");
    return worktree;
  }
  rmSync(worktree, { recursive: true, force: true });
  throw new ContractViolation("fixture missing", [
    { code: "runner.fixture.missing", message: `Missing fixture directory for ${input.problem.id}.` },
  ]);
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

function isEditablePatchTarget(allowedPaths: Set<string>, target: string): boolean {
  return allowedPaths.has(target) || allowedPaths.has("**/*");
}

export function assertPatchTargetsAllowed(problem: Problem, patch: string): ParsedFilePatch[] {
  const allowedPaths = new Set(problem.editableFilePaths);
  const parsed = parseUnifiedDiff(patch);
  for (const filePatch of parsed) {
    if (!isEditablePatchTarget(allowedPaths, filePatch.path)) {
      throw patchViolation("patch.target.notEditable", `Patch target is not editable for ${problem.id}: ${filePatch.path}`);
    }
  }
  return parsed;
}
function assertPatchTargetsAllowedByDescriptor(problem: Problem, patch: string, allowedTargets: readonly string[]): ParsedFilePatch[] {
  const descriptorAllowedPaths = new Set(allowedTargets);
  const parsed = assertPatchTargetsAllowed(problem, patch);
  for (const filePatch of parsed) {
    if (!descriptorAllowedPaths.has(filePatch.path)) {
      throw patchViolation("patch.target.notAllowedByDescriptor", `Patch target is not allowed by private descriptor for ${problem.id}: ${filePatch.path}`);
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

type HiddenOracleSelection =
  | {
      oracleKind: "python-function-cases";
      entryPoint: string;
      cases: HiddenOracleCase[];
      evidencePolicy: PrivateOracleEvidencePolicy;
    }
  | {
      oracleKind: "python-function-tests";
      entryPoint: string;
      testSource: string;
      testSourceHash: string;
      evidencePolicy: PrivateOracleEvidencePolicy;
    }
  | {
      oracleKind: "command-hidden-tests";
      commandId: string;
      allowedTargets: readonly string[];
      testSource: string;
      testSourceHash: string;
      expectedExitCode: number;
      evidencePolicy: PrivateOracleEvidencePolicy;
    }
  | {
      oracleKind: "swebench-upstream-harness";
      datasetName: string;
      datasetRevision: string;
      split: string;
      instanceId: string;
      repo: string;
      baseCommit: string;
      harnessCommit: string;
      harnessImageDigest: string;
      predictionJsonlSchemaHash: string;
      cacheKey: string;
      evidencePolicy: PrivateOracleEvidencePolicy;
    };

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

  const selected = selectCanonicalPrivateOracleDescriptor(
    {
      problemId: problem.id,
      benchmarkId: problem.benchmarkId,
      adapterId: problem.adapterId,
      upstreamTaskId: problem.upstreamTaskId,
      expectedOracleDescriptorHash: problem.oracleMetadata?.oracleDescriptorHash,
    },
    parsed,
  );
  if (selected) return selected.canonicalJson;


  throw new ContractViolation("private oracle descriptor invalid", [
    { code: "runner.privateOracle.invalidShape", message: "Private oracle descriptor must target the problem and include a supported hidden oracle payload." },
  ]);
}

function assertScoredHiddenOracleProblem(problem: Problem): string {
  const oracle = problem.oracleMetadata;
  if (
    problem.scoringMode !== "scored-hidden" ||
    !oracle ||
    (oracle.kind !== "hidden-fixture" && oracle.kind !== "generated-private") ||
    oracle.hiddenRequired !== true ||
    !/^sha256:[0-9a-f]{64}$/i.test(oracle.oracleDescriptorHash)
  ) {
    throw new ContractViolation("private oracle metadata missing", [
      {
        code: "runner.privateOracle.metadataRequired",
        message: "Scored hidden-oracle execution requires scored-hidden problem metadata with a private oracle descriptor hash.",
      },
    ]);
  }
  return oracle.oracleDescriptorHash;
}

function parsePrivateOracleDescriptor(problem: Problem): HiddenOracleSelection {
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

  const validation = validatePrivateOracleDescriptor(descriptor, {
    problemId: problem.id,
    benchmarkId: problem.benchmarkId,
    adapterId: problem.adapterId,
    upstreamTaskId: problem.upstreamTaskId,
  });
  if (!validation.ok) {
    throw new ContractViolation("private oracle descriptor invalid", validation.issues);
  }
  if (
    descriptor.oracleKind !== "python-function-cases" &&
    descriptor.oracleKind !== "python-function-tests" &&
    descriptor.oracleKind !== "command-hidden-tests" &&
    descriptor.oracleKind !== "swebench-upstream-harness"
  ) {
    throw new ContractViolation("private oracle descriptor unsupported", [
      { code: "runner.privateOracle.unsupportedKind", message: "This runner supports Python function case, official test-source, command hidden-test, and SWE-bench upstream harness descriptors only." },
    ]);
  }

  if (descriptor.oracleKind === "python-function-tests") {
    return {
      oracleKind: descriptor.oracleKind,
      entryPoint: descriptor.entryPoint,
      testSource: descriptor.testSource,
      testSourceHash: descriptor.testSourceHash,
      evidencePolicy: descriptor.evidencePolicy,
    };
  }
  if (descriptor.oracleKind === "command-hidden-tests") {
    if (descriptor.commandId !== "pytest-hidden") {
      throw new ContractViolation("private oracle descriptor unsupported", [
        { code: "runner.privateOracle.commandUnsupported", message: "Unsupported command-hidden-tests commandId." },
      ]);
    }
    return {
      oracleKind: descriptor.oracleKind,
      commandId: descriptor.commandId,
      allowedTargets: descriptor.allowedTargets,
      testSource: descriptor.testSource,
      testSourceHash: descriptor.testSourceHash,
      expectedExitCode: descriptor.expectedExitCode,
      evidencePolicy: descriptor.evidencePolicy,
    };
  }
  if (descriptor.oracleKind === "swebench-upstream-harness") {
    return {
      oracleKind: descriptor.oracleKind,
      datasetName: descriptor.datasetName,
      datasetRevision: descriptor.datasetRevision,
      split: descriptor.split,
      instanceId: descriptor.instanceId,
      repo: descriptor.repo,
      baseCommit: descriptor.baseCommit,
      harnessCommit: descriptor.harnessCommit,
      harnessImageDigest: descriptor.harnessImageDigest,
      predictionJsonlSchemaHash: descriptor.predictionJsonlSchemaHash,
      cacheKey: descriptor.cacheKey,
      evidencePolicy: descriptor.evidencePolicy,
    };
  }

  return {
    oracleKind: descriptor.oracleKind,
    entryPoint: descriptor.entryPoint,
    cases: descriptor.cases as HiddenOracleCase[],
    evidencePolicy: descriptor.evidencePolicy,
  };
}

function hiddenOracleSelection(problem: Problem): HiddenOracleSelection {
  return parsePrivateOracleDescriptor(problem);
}

const HIDDEN_ORACLE_STARTED_SENTINEL_PREFIX = "__AGENTOJ_HIDDEN_ORACLE_STARTED__:";

function hiddenOracleSentinel(): string {
  return `${HIDDEN_ORACLE_STARTED_SENTINEL_PREFIX}${randomBytes(16).toString("hex")}`;
}

function hiddenOracleStarted(stderr: string, sentinel: string): boolean {
  return stderr.includes(sentinel);
}

function sanitizeHiddenOracleStderr(timedOut: boolean, fallback: string): string {
  return timedOut ? "hidden oracle timed out" : fallback;
}
function isolatedCandidateChildSource(): string {
  return [
    "import importlib.util, json, pathlib, sys",
    "solution_path = pathlib.Path(sys.argv[1])",
    "entry_point = sys.argv[2]",
    "payload = json.loads(sys.stdin.read())",
    "spec = importlib.util.spec_from_file_location('submitted_solution', solution_path)",
    "module = importlib.util.module_from_spec(spec)",
    "assert spec and spec.loader",
    "spec.loader.exec_module(module)",
    "if not entry_point.isidentifier(): raise ValueError('invalid entry point')",
    "result = getattr(module, entry_point)(*payload['args'])",
    "sys.stdout.write(json.dumps({'result': result}, sort_keys=True, separators=(',', ':')))",
  ].join("\n");
}

function solutionHarnessSource(): string {
  return [
    "import json, pathlib, subprocess, sys",
    "payload = json.loads(sys.stdin.read())",
    "solution_path = pathlib.Path('/solution/solution.py' if pathlib.Path('/solution/solution.py').exists() else sys.argv[1])",
    "entry_point = payload['entryPoint']",
    "if not entry_point.isidentifier(): raise ValueError('invalid entry point')",
    "child_source = payload['c']",
    "sys.stderr.write(payload['n'] + '\\n')",
    "sys.stderr.flush()",
    "completed = subprocess.run([sys.executable, '-I', '-c', child_source, str(solution_path), entry_point], input=json.dumps({'args': payload['args']}), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)",
    "if completed.returncode != 0: raise AssertionError('candidate subprocess failed')",
    "sys.stdout.write(completed.stdout)",
  ].join("\n");
}

function officialTestHarnessSource(): string {
  return [
    "import hashlib, json, pathlib, subprocess, sys",
    "payload = json.loads(sys.stdin.read())",
    "test_source = payload['s']",
    "expected_hash = payload['h']",
    "actual_hash = 'sha256:' + hashlib.sha256(test_source.encode()).hexdigest()",
    "if actual_hash != expected_hash: raise AssertionError('test source hash mismatch')",
    "solution_path = pathlib.Path('/solution/solution.py' if pathlib.Path('/solution/solution.py').exists() else sys.argv[1])",
    "entry_point = payload['e']",
    "if not entry_point.isidentifier(): raise ValueError('invalid entry point')",
    "child_source = payload['c']",
    "def candidate(*args):",
    "    completed = subprocess.run([sys.executable, '-I', '-c', child_source, str(solution_path), entry_point], input=json.dumps({'args': args}), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)",
    "    if completed.returncode != 0: raise AssertionError('candidate subprocess failed')",
    "    return json.loads(completed.stdout)['result']",
    "namespace = {}",
    "exec(test_source, namespace)",
    "check = namespace.get('check')",
    "if not callable(check): raise AssertionError('missing check(candidate)')",
    "sys.stderr.write(payload['n'] + '\\n')",
    "sys.stderr.flush()",
    "check(candidate)",
  ].join("\n");
}

function officialTestPayload(testSource: string, testSourceHash: string, entryPoint: string, sentinel: string): string {
  return JSON.stringify({ e: entryPoint, s: testSource, h: testSourceHash, n: sentinel, c: isolatedCandidateChildSource() });
}
function commandHiddenHarnessSource(): string {
  return [
    "import ast, hashlib, json, os, pathlib, shutil, subprocess, sys, tempfile",
    "payload = json.loads(sys.stdin.read())",
    "if payload['cid'] != 'pytest-hidden': raise AssertionError('unsupported command id')",
    "test_source = payload['s']",
    "expected_hash = payload['h']",
    "actual_hash = 'sha256:' + hashlib.sha256(test_source.encode()).hexdigest()",
    "if actual_hash != expected_hash: raise AssertionError('test source hash mismatch')",
    "if pathlib.Path('/target0').exists():",
    "    work_root = pathlib.Path(tempfile.mkdtemp(prefix='agentoj-work-'))",
    "    for index, target in enumerate(payload['targets']):",
    "        source = pathlib.Path('/target' + str(index))",
    "        dest = work_root / target",
    "        dest.parent.mkdir(parents=True, exist_ok=True)",
    "        shutil.copyfile(source, dest)",
    "else:",
    "    work_root = pathlib.Path(sys.argv[1])",
    "test_dir = pathlib.Path(tempfile.mkdtemp(prefix='agentoj-hidden-'))",
    "test_path = test_dir / 'test_hidden.py'",
    "test_path.write_text(test_source, encoding='utf8')",
    "proxy_root = pathlib.Path(tempfile.mkdtemp(prefix='agentoj-proxy-'))",
    "candidate_child_source = \"\"\"import importlib.util, json, pathlib, sys\\npayload = json.loads(sys.stdin.read())\\nmodule_path = pathlib.Path(payload['path'])\\nspec = importlib.util.spec_from_file_location('_agentoj_candidate_module', module_path)\\nmodule = importlib.util.module_from_spec(spec)\\nassert spec.loader is not None\\nspec.loader.exec_module(module)\\nresult = getattr(module, payload['function'])(*payload.get('args', []), **payload.get('kwargs', {}))\\nsys.stdout.write(json.dumps({'result': result}, sort_keys=True, separators=(',', ':')))\\n\"\"\"",
    "for target in payload['targets']:",
    "    target_path = pathlib.PurePosixPath(target)",
    "    if target_path.is_absolute() or '..' in target_path.parts or target_path.suffix != '.py': raise AssertionError('invalid command hidden target')",
    "    source_path = work_root.joinpath(*target_path.parts)",
    "    tree = ast.parse(source_path.read_text(encoding='utf8'))",
    "    function_names = [node.name for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]",
    "    if not function_names: raise AssertionError('command hidden target exposes no functions')",
    "    proxy_path = proxy_root.joinpath(*target_path.parts)",
    "    proxy_path.parent.mkdir(parents=True, exist_ok=True)",
    "    parent = proxy_path.parent",
    "    while parent != proxy_root.parent and parent.is_relative_to(proxy_root):",
    "        init_path = parent / '__init__.py'",
    "        if not init_path.exists(): init_path.write_text('', encoding='utf8')",
    "        if parent == proxy_root: break",
    "        parent = parent.parent",
    "    proxy_lines = ['import json, subprocess, sys', '_CHILD = ' + repr(candidate_child_source), '_TARGET = ' + repr(str(source_path)), 'def _agentoj_call(name, *args, **kwargs):', \"    completed = subprocess.run([sys.executable, '-I', '-c', _CHILD], input=json.dumps({'path': _TARGET, 'function': name, 'args': args, 'kwargs': kwargs}), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)\", \"    if completed.returncode != 0: raise AssertionError('candidate subprocess failed')\", \"    try: return json.loads(completed.stdout)['result']\", \"    except Exception as exc: raise AssertionError('candidate emitted invalid JSON') from exc\"]",
    "    for function_name in function_names:",
    "        proxy_lines.append('def ' + function_name + '(*args, **kwargs):')",
    "        proxy_lines.append('    return _agentoj_call(' + repr(function_name) + ', *args, **kwargs)')",
    "    proxy_path.write_text('\\n'.join(proxy_lines) + '\\n', encoding='utf8')",
    "report_path = test_dir / 'pytest-session.json'",
    "conftest_path = test_dir / 'conftest.py'",
    "conftest_path.write_text(\"import json, pathlib\\n\\ndef pytest_sessionfinish(session, exitstatus):\\n    pathlib.Path(\" + repr(str(report_path)) + \").write_text(json.dumps({'testscollected': session.testscollected, 'testsfailed': session.testsfailed, 'exitstatus': exitstatus}, sort_keys=True), encoding='utf8')\\n\", encoding='utf8')",
    "env = {'PATH': os.environ.get('PATH', ''), 'PYTHONPATH': str(proxy_root), 'PYTHONDONTWRITEBYTECODE': '1'}",
    "sys.stderr.write(payload['n'] + '\\n')",
    "sys.stderr.flush()",
    "completed = subprocess.run([sys.executable, '-m', 'pytest', '-q', str(test_path), '--confcutdir', str(test_dir)], cwd=str(work_root), env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)",
    "expected_exit = int(payload['x'])",
    "if completed.returncode != expected_exit: raise AssertionError('hidden command failed')",
    "if not report_path.exists(): raise AssertionError('hidden command did not complete pytest session')",
    "report = json.loads(report_path.read_text(encoding='utf8'))",
    "if int(report.get('exitstatus', -1)) != expected_exit: raise AssertionError('hidden command exit status mismatch')",
    "if int(report.get('testscollected', 0)) < 1: raise AssertionError('hidden command collected no tests')",
    "if int(report.get('testsfailed', 0)) != 0: raise AssertionError('hidden command reported failed tests')",
  ].join("\n");
}

function commandHiddenPayload(selection: Extract<HiddenOracleSelection, { oracleKind: "command-hidden-tests" }>, sentinel: string): string {
  return JSON.stringify({
    cid: selection.commandId,
    targets: selection.allowedTargets,
    s: selection.testSource,
    h: selection.testSourceHash,
    x: selection.expectedExitCode,
    n: sentinel,
  });
}

function hiddenOraclePayload(testCase: HiddenOracleCase, entryPoint: string, sentinel: string): string {
  return JSON.stringify({ args: testCase.args, entryPoint, n: sentinel, c: isolatedCandidateChildSource() });
}

function runLocalHiddenOracleCase(solutionPath: string, testCase: HiddenOracleCase, entryPoint: string, timeoutMs: number): HiddenOracleOutcome {
  const sentinel = hiddenOracleSentinel();
  const completed = spawnSync("python3", ["-I", "-c", solutionHarnessSource(), solutionPath], {
    encoding: "utf8",
    timeout: timeoutMs,
    env: { PATH: process.env.PATH ?? "" },
    input: hiddenOraclePayload(testCase, entryPoint, sentinel),
  });
  const stderr = `${completed.stderr ?? ""}${completed.error ? completed.error.message : ""}`;
  return {
    exitCode: completed.status ?? (completed.error ? 1 : 0),
    stdout: completed.stdout ?? "",
    stderr,
    timedOut: (completed.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
    oracleStarted: hiddenOracleStarted(stderr, sentinel),
  };
}

function runLocalOfficialTestOracle(solutionPath: string, selection: Extract<HiddenOracleSelection, { oracleKind: "python-function-tests" }>, timeoutMs: number): HiddenOracleOutcome {
  const sentinel = hiddenOracleSentinel();
  const completed = spawnSync(
    "python3",
    ["-I", "-c", officialTestHarnessSource(), solutionPath],
    {
      encoding: "utf8",
      timeout: timeoutMs,
      env: { PATH: process.env.PATH ?? "" },
      input: officialTestPayload(selection.testSource, selection.testSourceHash, selection.entryPoint, sentinel),
    },
  );
  const stderr = `${completed.stderr ?? ""}${completed.error ? completed.error.message : ""}`;
  return {
    exitCode: completed.status ?? (completed.error ? 1 : 0),
    stdout: completed.stdout ?? "",
    stderr,
    timedOut: (completed.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
    oracleStarted: hiddenOracleStarted(stderr, sentinel),
  };
}
function runLocalCommandHiddenOracle(worktree: string, selection: Extract<HiddenOracleSelection, { oracleKind: "command-hidden-tests" }>, timeoutMs: number): HiddenOracleOutcome {
  const sentinel = hiddenOracleSentinel();
  const completed = spawnSync("python3", ["-I", "-c", commandHiddenHarnessSource(), worktree], {
    cwd: worktree,
    encoding: "utf8",
    timeout: timeoutMs,
    env: { PATH: process.env.PATH ?? "" },
    input: commandHiddenPayload(selection, sentinel),
  });
  const stderr = `${completed.stderr ?? ""}${completed.error ? completed.error.message : ""}`;
  return {
    exitCode: completed.status ?? (completed.error ? 1 : 0),
    stdout: "",
    stderr,
    timedOut: (completed.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
    oracleStarted: hiddenOracleStarted(stderr, sentinel),
  };
}

function evaluateHiddenOracleOutcome(outcome: HiddenOracleOutcome, testCase: HiddenOracleCase): string | null {
  if (outcome.timedOut) return "hidden oracle timed out";
  if (outcome.exitCode !== 0) return "hidden oracle subprocess failed";
  try {
    const decoded = JSON.parse(outcome.stdout) as { result?: unknown };
    if (JSON.stringify(decoded.result) !== JSON.stringify(testCase.expected)) {
      return "hidden oracle mismatch";
    }
    return null;
  } catch {
    return "hidden oracle emitted invalid JSON";
  }
}
export function privateOracleStdout(_passedCaseIds: readonly string[], _allPassed: boolean): string {
  return "";
}


function runLocalHiddenOracle(input: LocalPatchRunInput, worktree: string, preselected?: HiddenOracleSelection): HiddenOracleOutcome {
  const selection = preselected ?? hiddenOracleSelection(input.problem);
  const timeoutMs = input.adapter.defaultResources.timeoutSeconds * 1000;
  const solutionPath = join(worktree, "solution.py");
  if (selection.oracleKind === "python-function-tests") {
    const outcome = runLocalOfficialTestOracle(solutionPath, selection, timeoutMs);
    if (outcome.exitCode !== 0 || outcome.timedOut) {
      return {
        exitCode: outcome.timedOut ? 124 : 1,
        stdout: "",
        stderr: sanitizeHiddenOracleStderr(outcome.timedOut, "official hidden oracle failed"),
        timedOut: outcome.timedOut,
        oracleStarted: outcome.oracleStarted,
      };
    }
    return { exitCode: 0, stdout: privateOracleStdout([selection.testSourceHash], true), stderr: "", timedOut: false, oracleStarted: outcome.oracleStarted };
  }
  if (selection.oracleKind === "command-hidden-tests") {
    const outcome = runLocalCommandHiddenOracle(worktree, selection, timeoutMs);
    if (outcome.exitCode !== 0 || outcome.timedOut) {
      return {
        exitCode: outcome.timedOut ? 124 : 1,
        stdout: "",
        stderr: sanitizeHiddenOracleStderr(outcome.timedOut, "command hidden oracle failed"),
        timedOut: outcome.timedOut,
        oracleStarted: outcome.oracleStarted,
      };
    }
    return { exitCode: 0, stdout: privateOracleStdout([selection.testSourceHash], true), stderr: "", timedOut: false, oracleStarted: outcome.oracleStarted };
  }
  if (selection.oracleKind === "swebench-upstream-harness") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "SWE-bench upstream harness scoring requires the Docker sandbox.",
      timedOut: false,
      oracleStarted: false,
    };
  }


  const passedCaseIds: string[] = [];
  let allOracleStartsObserved = true;
  for (const testCase of selection.cases) {
    const outcome = runLocalHiddenOracleCase(solutionPath, testCase, selection.entryPoint, timeoutMs);
    allOracleStartsObserved = allOracleStartsObserved && outcome.oracleStarted === true;
    const failure = evaluateHiddenOracleOutcome(outcome, testCase);
    if (failure) {
      return {
        exitCode: outcome.timedOut ? 124 : 1,
        stdout: privateOracleStdout(passedCaseIds, false),
        stderr: failure,
        timedOut: outcome.timedOut,
        oracleStarted: outcome.oracleStarted,
      };
    }
    passedCaseIds.push(testCase.id);
  }
  return { exitCode: 0, stdout: privateOracleStdout(passedCaseIds, true), stderr: "", timedOut: false, oracleStarted: allOracleStartsObserved };
}

function dockerContainerName(input: LocalPatchRunInput, runSeed: string, publicRunLabel: string): string {
  return stableId("agentoj", `${input.problem.id}-${input.submission.id}-${runSeed}-${publicRunLabel}`).slice(0, 63);
}


export function dockerHiddenOracleRunArgs(
  input: LocalPatchRunInput,
  solutionPath: string,
  testCase: HiddenOracleCase,
  containerName: string,
  entryPoint: string,
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
    "-i",
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
    "/solution/solution.py",
  ];
}

export function dockerOfficialTestRunArgs(
  input: LocalPatchRunInput,
  solutionPath: string,
  selection: Extract<HiddenOracleSelection, { oracleKind: "python-function-tests" }>,
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
    "-i",
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
    officialTestHarnessSource(),
    "/solution/solution.py",
  ];
}
export function dockerCommandHiddenRunArgs(
  input: LocalPatchRunInput,
  worktree: string,
  selection: Extract<HiddenOracleSelection, { oracleKind: "command-hidden-tests" }>,
  containerName: string,
): string[] {
  if (!isPinnedDockerImageDigest(input.adapter.dockerImageDigest)) {
    throw new ContractViolation("docker image must be digest-pinned", [
      { code: "runner.dockerDigest.required", message: "Docker sandbox requires image@sha256:<digest>." },
    ]);
  }
  const targetMounts: string[] = [];
  for (const [index, target] of selection.allowedTargets.entries()) {
    const absolutePath = assertInsideWorktree(worktree, target);
    assertNoSymlinkPath(worktree, absolutePath, target);
    const stat = lstatIfPresent(absolutePath);
    if (!stat?.isFile()) {
      throw patchViolation("patch.target.missing", `Allowed target is not a regular file after patch application: ${target}`);
    }
    targetMounts.push("-v", `${absolutePath}:/target${index}:ro,z`);
  }
  const memory = `${Math.max(32, Math.trunc(input.adapter.defaultResources.memoryMb))}m`;
  return [
    "run",
    "--rm",
    "-i",
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
    ...targetMounts,
    "-w",
    "/tmp",
    "--env",
    "PYTHONDONTWRITEBYTECODE=1",
    input.adapter.dockerImageDigest,
    "python3",
    "-I",
    "-c",
    commandHiddenHarnessSource(),
    "/tmp",
  ];
}
const SWEBENCH_PREDICTION_JSONL_SCHEMA = {
  schemaVersion: 1,
  kind: "swebench-prediction-jsonl",
  fields: ["instance_id", "model_name_or_path", "model_patch"],
} as const;

function swebenchPredictionJsonlSchemaHash(): string {
  return `sha256:${sha256(JSON.stringify(SWEBENCH_PREDICTION_JSONL_SCHEMA))}`;
}

function swebenchPredictionJsonl(input: LocalPatchRunInput, selection: Extract<HiddenOracleSelection, { oracleKind: "swebench-upstream-harness" }>): string {
  return `${JSON.stringify({
    instance_id: selection.instanceId,
    model_name_or_path: "open-agent-judge-pr",
    model_patch: input.patch,
  })}\n`;
}

function writeSwebenchPredictionJsonl(worktree: string, input: LocalPatchRunInput, selection: Extract<HiddenOracleSelection, { oracleKind: "swebench-upstream-harness" }>): string {
  const predictionPath = join(worktree, "predictions.jsonl");
  writeFileSync(predictionPath, swebenchPredictionJsonl(input, selection), "utf8");
  return predictionPath;
}

export function validateSwebenchPredictionJsonl(
  predictionJsonl: string,
  input: LocalPatchRunInput,
  selection: Extract<HiddenOracleSelection, { oracleKind: "swebench-upstream-harness" }>,
): { predictionJsonlHash: string; predictionJsonlSchemaHash: string } {
  const predictionJsonlSchemaHash = swebenchPredictionJsonlSchemaHash();
  if (selection.predictionJsonlSchemaHash !== predictionJsonlSchemaHash) {
    throw new ContractViolation("SWE-bench prediction schema mismatch", [
      { code: "runner.swebench.predictionSchema.mismatch", message: "SWE-bench descriptor predictionJsonlSchemaHash must match the runner schema." },
    ]);
  }
  const lines = predictionJsonl.split("\n").filter((line) => line.length > 0);
  if (lines.length !== 1) {
    throw new ContractViolation("SWE-bench prediction JSONL invalid", [
      { code: "runner.swebench.predictionJsonl.lineCount", message: "SWE-bench prediction JSONL must contain exactly one prediction row." },
    ]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines[0]);
  } catch {
    throw new ContractViolation("SWE-bench prediction JSONL invalid", [
      { code: "runner.swebench.predictionJsonl.invalidJson", message: "SWE-bench prediction JSONL row must be valid JSON." },
    ]);
  }
  const row = parsed as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["instance_id", "model_name_or_path", "model_patch"])) {
    throw new ContractViolation("SWE-bench prediction JSONL invalid", [
      { code: "runner.swebench.predictionJsonl.keys", message: "SWE-bench prediction JSONL row must contain only the official prediction keys." },
    ]);
  }
  if (row.instance_id !== selection.instanceId || row.model_name_or_path !== "open-agent-judge-pr" || row.model_patch !== input.patch) {
    throw new ContractViolation("SWE-bench prediction JSONL invalid", [
      { code: "runner.swebench.predictionJsonl.binding", message: "SWE-bench prediction JSONL must bind the selected instance and submitted patch." },
    ]);
  }
  return {
    predictionJsonlHash: `sha256:${sha256(predictionJsonl)}`,
    predictionJsonlSchemaHash,
  };
}

export function swebenchResolvedEvidenceFromReport(
  reportText: string,
  selection: Extract<HiddenOracleSelection, { oracleKind: "swebench-upstream-harness" }>,
  predictionEvidence: { predictionJsonlHash: string; predictionJsonlSchemaHash: string },
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reportText);
  } catch {
    throw new ContractViolation("SWE-bench report invalid", [
      { code: "runner.swebench.report.invalidJson", message: "SWE-bench official report must be valid JSON." },
    ]);
  }
  const report = parsed as Record<string, unknown>;
  const submitted = Array.isArray(report.submitted_ids) ? report.submitted_ids : [];
  const completed = Array.isArray(report.completed_ids) ? report.completed_ids : [];
  const resolved = Array.isArray(report.resolved_ids) ? report.resolved_ids : [];
  const unresolved = Array.isArray(report.unresolved_ids) ? report.unresolved_ids : [];
  const errors = Array.isArray(report.error_ids) ? report.error_ids : [];
  if (
    report.schema_version !== 2 ||
    submitted.length !== 1 ||
    submitted[0] !== selection.instanceId ||
    completed.length !== 1 ||
    completed[0] !== selection.instanceId ||
    resolved.length !== 1 ||
    resolved[0] !== selection.instanceId ||
    unresolved.includes(selection.instanceId) ||
    errors.includes(selection.instanceId)
  ) {
    throw new ContractViolation("SWE-bench report unresolved", [
      { code: "runner.swebench.report.unresolved", message: "SWE-bench official report must show the allowlisted instance completed and resolved." },
    ]);
  }
  return JSON.stringify({
    kind: "swebench-official-report",
    instanceId: selection.instanceId,
    datasetName: selection.datasetName,
    datasetRevision: selection.datasetRevision,
    harnessCommit: selection.harnessCommit,
    harnessImageDigest: selection.harnessImageDigest,
    cacheKey: selection.cacheKey,
    predictionJsonlHash: predictionEvidence.predictionJsonlHash,
    predictionJsonlSchemaHash: predictionEvidence.predictionJsonlSchemaHash,
    reportHash: `sha256:${sha256(reportText)}`,
    resolved: true,
  });
}

export function dockerSwebenchRunArgs(
  input: LocalPatchRunInput,
  predictionJsonlPath: string,
  selection: Extract<HiddenOracleSelection, { oracleKind: "swebench-upstream-harness" }>,
  _containerName: string,
  _sentinel: string,
): string[] {
  validateSwebenchPredictionJsonl(readFileSync(predictionJsonlPath, "utf8"), input, selection);
  if (!isPinnedDockerImageDigest(input.adapter.dockerImageDigest)) {
    throw new ContractViolation("docker image must be digest-pinned", [
      { code: "runner.dockerDigest.required", message: "Docker sandbox requires image@sha256:<digest>." },
    ]);
  }
  if (selection.harnessImageDigest !== input.adapter.dockerImageDigest) {
    throw new ContractViolation("SWE-bench harness image mismatch", [
      { code: "runner.swebench.harnessImageDigest.mismatch", message: "SWE-bench descriptor harnessImageDigest must match the adapter Docker image digest." },
    ]);
  }
  if (selection.harnessCommit !== input.benchmark.upstreamCommitOrVersion) {
    throw new ContractViolation("SWE-bench harness commit mismatch", [
      { code: "runner.swebench.harnessCommit.mismatch", message: "SWE-bench descriptor harnessCommit must match the benchmark pinned upstream commit." },
    ]);
  }
  return ["image", "inspect", input.adapter.dockerImageDigest];
}
export function dockerSwebenchPullArgs(input: LocalPatchRunInput): string[] {
  if (!isPinnedDockerImageDigest(input.adapter.dockerImageDigest)) {
    throw new ContractViolation("docker image must be digest-pinned", [
      { code: "runner.dockerDigest.required", message: "Docker sandbox requires image@sha256:<digest>." },
    ]);
  }
  return ["pull", input.adapter.dockerImageDigest];
}

function verifiedSwebenchHarnessPath(selection: Extract<HiddenOracleSelection, { oracleKind: "swebench-upstream-harness" }>): string {
  const harnessPath = process.env.AGENTOJ_SWEBENCH_HARNESS_PATH;
  if (!harnessPath) {
    throw new ContractViolation("SWE-bench harness checkout required", [
      { code: "runner.swebench.harnessPath.required", message: "SWE-bench scoring requires a trusted checkout of the pinned official harness." },
    ]);
  }
  const revision = spawnSync("git", ["-C", harnessPath, "rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 10_000,
    env: { PATH: process.env.PATH ?? "" },
  });
  if (revision.status !== 0 || revision.stdout.trim() !== selection.harnessCommit) {
    throw new ContractViolation("SWE-bench harness commit mismatch", [
      { code: "runner.swebench.harnessCheckout.mismatch", message: "Trusted SWE-bench harness checkout must match the descriptor harnessCommit." },
    ]);
  }
  return harnessPath;
}


function writeSwebenchHarnessWrapper(worktree: string): string {
  const wrapperPath = join(worktree, "run-swebench-pinned.py");
  writeFileSync(
    wrapperPath,
    [
      "import os, runpy, sys",
      "import swebench.harness.utils as utils",
      "from datasets import load_dataset",
      "",
      "def pinned_load(name, split, instance_ids=None):",
      "    if name == os.environ['OAJ_SWEBENCH_DATASET_NAME']:",
      "        dataset = load_dataset(name, split=split, revision=os.environ['OAJ_SWEBENCH_DATASET_REVISION'])",
      "        if instance_ids:",
      "            allowed = set(instance_ids)",
      "            return [row for row in dataset if row['instance_id'] in allowed]",
      "        return dataset",
      "    return utils.load_swebench_dataset(name, split, instance_ids)",
      "",
      "utils.load_swebench_dataset = pinned_load",
      "sys.argv = [",
      "    'run_evaluation',",
      "    '--dataset_name', sys.argv[1],",
      "    '--split', sys.argv[2],",
      "    '--predictions_path', sys.argv[3],",
      "    '--instance_ids', sys.argv[4],",
      "    '--max_workers', '1',",
      "    '--run_id', sys.argv[5],",
      "    '--cache_level', 'instance',",
      "    '--timeout', '2700',",
      "    '--namespace', 'swebench',",
      "]",
      "runpy.run_module('swebench.harness.run_evaluation', run_name='__main__')",
      "",
    ].join("\n"),
    "utf8",
  );
  return wrapperPath;
}

export function swebenchHostHarnessRunArgs(
  wrapperPath: string,
  predictionJsonlPath: string,
  selection: Extract<HiddenOracleSelection, { oracleKind: "swebench-upstream-harness" }>,
  runId: string,
): string[] {
  return [wrapperPath, selection.datasetName, selection.split, predictionJsonlPath, selection.instanceId, runId];
}

export function dockerRunArgs(input: LocalPatchRunInput, worktree: string): string[] {
  const selection = hiddenOracleSelection(input.problem);
  if (selection.oracleKind === "python-function-tests") {
    return dockerOfficialTestRunArgs(input, join(worktree, "solution.py"), selection, dockerContainerName(input, sha256(input.patch), "official"));
  }
  if (selection.oracleKind === "command-hidden-tests") {
    return dockerCommandHiddenRunArgs(input, worktree, selection, dockerContainerName(input, sha256(input.patch), "command"));
  }
  if (selection.oracleKind === "swebench-upstream-harness") {
    const sentinel = hiddenOracleSentinel();
    const predictionPath = writeSwebenchPredictionJsonl(worktree, input, selection);
    return dockerSwebenchRunArgs(input, predictionPath, selection, dockerContainerName(input, sha256(input.patch), "swebench"), sentinel);
  }

  const [firstCase] = selection.cases;
  return dockerHiddenOracleRunArgs(
    input,
    join(worktree, "solution.py"),
    firstCase,
    dockerContainerName(input, sha256(input.patch), "case"),
    selection.entryPoint,
  );
}

function scoringStatusFor(input: LocalPatchRunInput, hiddenOracleExecuted: boolean): RunnerJob["scoringStatus"] {
  return hiddenOracleExecuted && input.problem.scoringMode === "scored-hidden" ? "scored" : "demo";
}

function oracleDescriptorHashFor(input: LocalPatchRunInput, hiddenOracleExecuted: boolean): string | null {
  return hiddenOracleExecuted && input.problem.scoringMode === "scored-hidden" ? (input.problem.oracleMetadata?.oracleDescriptorHash ?? null) : null;
}

export function runLocalPatchVerification(input: LocalPatchRunInput): LocalPatchVerificationRun {
  const worktree = createFixtureWorktree(input, `agentoj-${input.problem.id}-`);
  const runSeed = runSeedFor(input);

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
    scoringStatus: scoringStatusFor(input, false),
    sandboxMode: "local",
    oracleDescriptorHash: oracleDescriptorHashFor(input, false),
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
  const worktree = createFixtureWorktree(input, `agentoj-${input.problem.id}-hidden-`);
  const runSeed = runSeedFor(input, "hidden-oracle");

  let patchApplyStatus: RunnerResult["patchApplyStatus"] = "clean";
  let exitCode = 1;
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let hiddenOracleExecuted = false;

  const startedAt = process.hrtime.bigint();

  try {
    assertUnsafeLocalHiddenOracleEnabled();
    const selection = hiddenOracleSelection(input.problem);
    if (selection.oracleKind === "command-hidden-tests") {
      assertPatchTargetsAllowedByDescriptor(input.problem, input.patch, selection.allowedTargets);
    } else {
      assertPatchTargetsAllowed(input.problem, input.patch);
    }
    applyUnifiedDiff(worktree, input.patch);
    rmSync(join(worktree, "tests"), { recursive: true, force: true });
    const outcome = runLocalHiddenOracle(input, worktree, selection);
    exitCode = outcome.exitCode;
    stdout = outcome.stdout;
    stderr = outcome.stderr;
    timedOut = outcome.timedOut;
    hiddenOracleExecuted = outcome.oracleStarted === true;
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
    scoringStatus: scoringStatusFor(input, hiddenOracleExecuted),
    sandboxMode: "local",
    oracleDescriptorHash: oracleDescriptorHashFor(input, hiddenOracleExecuted),
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
    const selection = hiddenOracleSelection(input.problem);
    if (selection.oracleKind === "command-hidden-tests") {
      assertPatchTargetsAllowedByDescriptor(input.problem, input.patch, selection.allowedTargets);
    } else {
      assertPatchTargetsAllowed(input.problem, input.patch);
    }
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
      scoringStatus: scoringStatusFor(input, false),
      sandboxMode: "docker",
      oracleDescriptorHash: oracleDescriptorHashFor(input, false),
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
      scoringStatus: scoringStatusFor(input, false),
      sandboxMode: "docker",
      oracleDescriptorHash: oracleDescriptorHashFor(input, false),
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

  const dockerSelection = hiddenOracleSelection(input.problem);
  if (dockerSelection.oracleKind === "swebench-upstream-harness") {
    const worktree = mkdtempSync(join(tmpdir(), `agentoj-${input.problem.id}-swebench-`));
    const runSeed = runSeedFor(input, "docker-swebench");
    let exitCode = 1;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let hiddenOracleExecuted = false;
    let dockerDiagnosticStderr = "";
    const startedAt = process.hrtime.bigint();
    try {
      const predictionPath = writeSwebenchPredictionJsonl(worktree, input, dockerSelection);
      const predictionEvidence = validateSwebenchPredictionJsonl(readFileSync(predictionPath, "utf8"), input, dockerSelection);
      const runId = stableId("swebench", `${input.problem.id}-${input.submission.id}`);
      const imagePull = spawnSync("docker", dockerSwebenchPullArgs(input), {
        encoding: "utf8",
        timeout: 120_000,
        env: { PATH: process.env.PATH ?? "" },
      });
      if (imagePull.status !== 0) {
        dockerDiagnosticStderr = `${imagePull.stderr ?? ""}${imagePull.error ? imagePull.error.message : ""}`;
        exitCode = 1;
        stderr = sanitizeHiddenOracleStderr(false, "SWE-bench pinned image unavailable");
      } else {
        const imageProbe = spawnSync("docker", dockerSwebenchRunArgs(input, predictionPath, dockerSelection, "agentoj-swebench-image-probe", ""), {
          encoding: "utf8",
          timeout: 30_000,
          env: { PATH: process.env.PATH ?? "" },
        });
        if (imageProbe.status !== 0) {
          dockerDiagnosticStderr = `${imageProbe.stderr ?? ""}${imageProbe.error ? imageProbe.error.message : ""}`;
          exitCode = 1;
          stderr = sanitizeHiddenOracleStderr(false, "SWE-bench pinned image unavailable");
        } else {
          const harnessPath = verifiedSwebenchHarnessPath(dockerSelection);
          const wrapperPath = writeSwebenchHarnessWrapper(worktree);
          const completed = spawnSync("python3", swebenchHostHarnessRunArgs(wrapperPath, predictionPath, dockerSelection, runId), {
            cwd: worktree,
            encoding: "utf8",
            timeout: input.adapter.defaultResources.timeoutSeconds * 1000,
            env: {
              PATH: process.env.PATH ?? "",
              PYTHONPATH: [harnessPath, process.env.PYTHONPATH].filter(Boolean).join(":"),
              OAJ_SWEBENCH_DATASET_NAME: dockerSelection.datasetName,
              OAJ_SWEBENCH_DATASET_REVISION: dockerSelection.datasetRevision,
            },
          });
          const rawStderr = `${completed.stderr ?? ""}${completed.error ? completed.error.message : ""}`;
          dockerDiagnosticStderr = rawStderr;
          timedOut = (completed.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
          hiddenOracleExecuted = completed.status === 0 && !timedOut;
          if (hiddenOracleExecuted) {
            const reportPath = join(worktree, `open-agent-judge-pr.${runId}.json`);
            const reportEvidence = swebenchResolvedEvidenceFromReport(readFileSync(reportPath, "utf8"), dockerSelection, predictionEvidence);
            exitCode = 0;
            stdout = reportEvidence;
          } else {
            exitCode = timedOut ? 124 : 1;
            stderr = sanitizeHiddenOracleStderr(timedOut, "SWE-bench upstream harness failed");
          }
        }
      }
    } catch (error) {
      stderr =
        error instanceof ContractViolation
          ? `${error.message}: ${error.issues.map((issue) => issue.message).join("; ")}`
          : error instanceof Error
            ? error.message
            : String(error);
    }
    const passed = exitCode === 0 && !timedOut;
    const infrastructureFailure = !passed && isDockerInfrastructureFailure(dockerDiagnosticStderr || stderr);
    const hiddenOracleScored = hiddenOracleExecuted && !infrastructureFailure;
    const job: RunnerJob = {
      id: stableId("job", runSeed),
      submissionId: input.submission.id,
      adapterId: input.adapter.id,
      upstreamCommit: input.benchmark.upstreamCommitOrVersion,
      dockerImageDigest: input.adapter.dockerImageDigest,
      resources: input.adapter.defaultResources,
      status: timedOut ? "timed-out" : infrastructureFailure ? "infra-error" : passed ? "passed" : "failed",
      scoringStatus: scoringStatusFor(input, hiddenOracleScored),
      sandboxMode: "docker",
      oracleDescriptorHash: oracleDescriptorHashFor(input, hiddenOracleScored),
    };
    const result: RunnerResult = {
      id: stableId("result", runSeed),
      jobId: job.id,
      patchApplyStatus: "clean",
      exitCode,
      passFail: passed ? "pass" : "fail",
      runtimeMs: measuredRuntimeMs(startedAt),
      memoryPeakMb: null,
      stdoutRef: `stdout:${sha256(stdout)}`,
      stderrRef: `stderr:${sha256(stderr)}`,
      resultHash: `result:${sha256(`${job.id}:swebench:${exitCode}:${stdout}:${stderr}`)}`,
    };
    if (!input.keepWorktree) rmSync(worktree, { recursive: true, force: true });
    return { job, result, worktree, stdout, stderr, sandboxMode: "docker" };
  }
  const worktree = createFixtureWorktree(input, `agentoj-${input.problem.id}-docker-`);
  const runSeed = runSeedFor(input, "docker");

  let patchApplyStatus: RunnerResult["patchApplyStatus"] = "clean";
  let exitCode = 1;
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let hiddenOracleExecuted = false;
  let dockerDiagnosticStderr = "";

  const startedAt = process.hrtime.bigint();

  try {
    applyUnifiedDiff(worktree, input.patch);
    const selection = dockerSelection;
    const solutionPath = join(worktree, "solution.py");
    const timeoutMs = input.adapter.defaultResources.timeoutSeconds * 1000;
    if (selection.oracleKind === "python-function-tests") {
      const containerName = dockerContainerName(input, runSeed, "official");
      const sentinel = hiddenOracleSentinel();
      const completed = spawnSync("docker", dockerOfficialTestRunArgs(input, solutionPath, selection, containerName), {
        encoding: "utf8",
        timeout: timeoutMs,
        env: { PATH: process.env.PATH ?? "" },
        input: officialTestPayload(selection.testSource, selection.testSourceHash, selection.entryPoint, sentinel),
      });
      const rawStderr = `${completed.stderr ?? ""}${completed.error ? completed.error.message : ""}`;
      dockerDiagnosticStderr = rawStderr;
      stdout = "";
      stderr = "";
      timedOut = (completed.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
      hiddenOracleExecuted = hiddenOracleStarted(rawStderr, sentinel);
      spawnSync("docker", ["rm", "-f", containerName], {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "" },
      });
      if (completed.status === 0 && !timedOut && hiddenOracleExecuted) {
        exitCode = 0;
        stdout = privateOracleStdout([selection.testSourceHash], true);
      } else {
        exitCode = timedOut ? 124 : 1;
        stderr = sanitizeHiddenOracleStderr(timedOut, "official hidden oracle failed");
      }
    } else if (selection.oracleKind === "command-hidden-tests") {
      const containerName = dockerContainerName(input, runSeed, "command");
      const sentinel = hiddenOracleSentinel();
      const completed = spawnSync("docker", dockerCommandHiddenRunArgs(input, worktree, selection, containerName), {
        encoding: "utf8",
        timeout: timeoutMs,
        env: { PATH: process.env.PATH ?? "" },
        input: commandHiddenPayload(selection, sentinel),
      });
      const rawStderr = `${completed.stderr ?? ""}${completed.error ? completed.error.message : ""}`;
      dockerDiagnosticStderr = rawStderr;
      stdout = "";
      stderr = "";
      timedOut = (completed.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
      hiddenOracleExecuted = hiddenOracleStarted(rawStderr, sentinel);
      spawnSync("docker", ["rm", "-f", containerName], {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "" },
      });
      if (completed.status === 0 && !timedOut && hiddenOracleExecuted) {
        exitCode = 0;
        stdout = privateOracleStdout([selection.testSourceHash], true);
      } else {
        exitCode = timedOut ? 124 : 1;
        stderr = sanitizeHiddenOracleStderr(timedOut, "command hidden oracle failed");
      }
    } else {
      const passedCaseIds: string[] = [];
      for (const [caseIndex, testCase] of selection.cases.entries()) {
        const containerName = dockerContainerName(input, runSeed, `case-${caseIndex}`);
        const sentinel = hiddenOracleSentinel();
        const completed = spawnSync("docker", dockerHiddenOracleRunArgs(input, solutionPath, testCase, containerName, selection.entryPoint), {
          encoding: "utf8",
          timeout: timeoutMs,
          env: { PATH: process.env.PATH ?? "" },
          input: hiddenOraclePayload(testCase, selection.entryPoint, sentinel),
        });
        const caseStdout = completed.stdout ?? "";
        const caseStderr = `${completed.stderr ?? ""}${completed.error ? completed.error.message : ""}`;
        dockerDiagnosticStderr = caseStderr;
        const caseTimedOut = (completed.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
        hiddenOracleExecuted = hiddenOracleExecuted || hiddenOracleStarted(caseStderr, sentinel);
        spawnSync("docker", ["rm", "-f", containerName], {
          encoding: "utf8",
          env: { PATH: process.env.PATH ?? "" },
        });
        const failure = evaluateHiddenOracleOutcome(
          { exitCode: completed.status ?? (completed.error ? 1 : 0), stdout: caseStdout, stderr: caseStderr, timedOut: caseTimedOut },
          testCase,
        );
        if (failure) {
          exitCode = caseTimedOut ? 124 : 1;
          stdout = privateOracleStdout(passedCaseIds, false);
          stderr = sanitizeHiddenOracleStderr(caseTimedOut, failure);
          timedOut = caseTimedOut;
          break;
        }
        passedCaseIds.push(testCase.id);
        exitCode = 0;
      }
      if (exitCode === 0) stdout = privateOracleStdout(passedCaseIds, true);
    }
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
  const infrastructureFailure = patchApplyStatus === "clean" && !passed && isDockerInfrastructureFailure(dockerDiagnosticStderr || stderr);
  const hiddenOracleScored = hiddenOracleExecuted && !infrastructureFailure;
  const job: RunnerJob = {
    id: stableId("job", runSeed),
    submissionId: input.submission.id,
    adapterId: input.adapter.id,
    upstreamCommit: input.benchmark.upstreamCommitOrVersion,
    dockerImageDigest: input.adapter.dockerImageDigest,
    resources: input.adapter.defaultResources,
    status: timedOut ? "timed-out" : infrastructureFailure ? "infra-error" : passed ? "passed" : "failed",
    scoringStatus: scoringStatusFor(input, hiddenOracleScored),
    sandboxMode: "docker",
    oracleDescriptorHash: oracleDescriptorHashFor(input, hiddenOracleScored),
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
