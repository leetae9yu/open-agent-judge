#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  ContractViolation,
  appendRunBundle,
  approveRecording,
  createFailedRunBundle,
  createLeaderboardEntry,
  createPatchSubmission,
  createRunBundle,
  createSolutionRecording,
  exportRecordingMarkdownFromSqlite,
  exportWebData,
  getImplementedProblemCatalog,
  listAdapterRegistry,
  listImplementedProblems,
  loadAgentOjApiConfig,
  openAgentOjDatabase,
  persistFailedRunToSqlite,
  persistRunBundleToSqlite,
  promoteToPublicMemory,
  readRunBundles,
  runAutomaticCheck,
  runPatchVerification,
  assertPatchTargetsAllowed,
  parseUnifiedDiff,
  searchSqlitePublicMemory,
  MAX_PR_PATCH_FILES,
  startAgentOjServer,
  validateImplementedAdapterSeeds,
  validatePrSubmissionEnvelope,
  validateSanitizedPrJudgeSummary,
  type PrSubmissionEnvelope,
  type ParsedFilePatch,
  type SanitizedPrJudgeSummary,
} from "./index.ts";

export interface CliRunResult {
  ok: boolean;
  problemId: string;
  patchBytes: number;
  recordingId?: string;
  leaderboardEntryId?: string;
  publicMemoryLink?: string;
  evidenceHash?: string;
  persistedRunPath?: string;
  persistedRunLine?: number;
  persistedDbPath?: string;
  runnerStatus?: string;
  runnerResultHash?: string;
  sandboxMode?: string;
  oracleMode?: "public-fixture-demo" | "hidden-oracle-scored";
  api?: {
    dbPath: string;
    host: string;
    port: number;
    runnerMode: string;
  };
  problems?: Array<{
    id: string;
    title: string;
    benchmarkId: string;
    hostingMode: string;
    tags: readonly string[];
  }>;
  problem?: {
    id: string;
    title: string;
    benchmarkId: string;
    upstreamTaskId: string;
    hostingMode: string;
    tags: readonly string[];
  };
  registry?: Array<{
    benchmarkId: string;
    name: string;
    licenseId: string;
    status: string;
    dataPolicy: string;
  }>;
  markdown?: string;
  results?: Array<{
    publicRecordingLink: string;
    actionChecklist: string[];
    sourceRecordingIds: string[];
    applicabilityExplanation: string;
  }>;
  exportedFiles?: string[];
  judgeSummary?: SanitizedPrJudgeSummary;
  summaryPath?: string;
  error?: string;
  issues?: string[];
}

function usage(): never {
  console.error(
    "Usage: node --experimental-strip-types src/cli.ts <list|show|registry|export-recording|export-web-data|memory|run|judge-pr-submission|serve> [problem-id] [--submission <json>] [--summary-out <json>] [--patch <patch-file>] [--out-dir <directory>] [--out <directory>] [--db <sqlite-file>] [--sandbox <local|docker>] [--error <signature>] [--framework <language>]",
  );
  process.exit(2);
}

function requireArg(args: string[], index: number): string {
  const value = args[index];
  if (!value) usage();
  return value;
}

function optionalFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : requireArg(args, index + 1);
}

function readPatch(path: string): string {
  const patch = readFileSync(path, "utf8");
  if (patch.trim().length === 0) throw new Error("Patch file is empty.");
  return patch;
}

function patchSeed(problemId: string, patch: string): string {
  return `${problemId}-${createHash("sha256").update(patch).digest("hex")}`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function patchStatsFromParsedDiff(parsedFiles: readonly ParsedFilePatch[]): PrSubmissionEnvelope["patchStats"] {
  return {
    filesChanged: parsedFiles.length,
    locAdded: parsedFiles.reduce((sum, file) => sum + file.locAdded, 0),
    locDeleted: parsedFiles.reduce((sum, file) => sum + file.locDeleted, 0),
  };
}

function expectedGitMode(file: ParsedFilePatch): string {
  return file.changeType === "delete" ? (file.oldMode ?? "100644") : (file.newMode ?? "100644");
}

function validateEnvelopeFilesAgainstPatch(
  envelope: Partial<PrSubmissionEnvelope>,
  parsedFiles: readonly ParsedFilePatch[],
): string[] {
  const issues: string[] = [];
  const envelopeFiles = Array.isArray(envelope.files) ? envelope.files : [];
  if (envelopeFiles.length !== parsedFiles.length) issues.push("prSubmission.files.patchMismatch");
  const parsedByPath = new Map(parsedFiles.map((file) => [file.path, file]));
  const seenEnvelopePaths = new Set<string>();
  for (const file of envelopeFiles) {
    if (!file || typeof file !== "object") continue;
    if (seenEnvelopePaths.has(file.path)) issues.push("prSubmission.files.duplicate");
    seenEnvelopePaths.add(file.path);
    const parsed = parsedByPath.get(file.path);
    if (!parsed) {
      issues.push("prSubmission.files.pathMismatch");
      continue;
    }
    if (file.changeType !== parsed.changeType) issues.push("prSubmission.files.changeTypeMismatch");
    if (file.gitMode !== expectedGitMode(parsed)) issues.push("prSubmission.files.gitModeMismatch");
    if (file.isBinary !== parsed.isBinary) issues.push("prSubmission.files.binaryMismatch");
    if (file.isSymlink !== parsed.isSymlink) issues.push("prSubmission.files.symlinkMismatch");
  }
  for (const parsed of parsedFiles) {
    if (!seenEnvelopePaths.has(parsed.path)) issues.push("prSubmission.files.missingPatchTarget");
  }
  return Array.from(new Set(issues));
}

function implementedJudgeOptions() {
  const problems = listImplementedProblems().filter((problem) => problem.enabled);
  return {
    enabledProblemIds: problems.map((problem) => problem.id),
    enabledAdapterIds: Array.from(new Set(problems.map((problem) => problem.adapterId))),
  };
}

function boundedMessage(value: string): string {
  return value.length <= 240 ? value : `${value.slice(0, 237)}...`;
}

function safePublicId(value: string, fallback: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(value) ? value : fallback;
}

function sanitizePatchStatsForSummary(stats: PrSubmissionEnvelope["patchStats"]): SanitizedPrJudgeSummary["patchStats"] {
  const filesChanged = Number.isFinite(stats.filesChanged) ? Math.trunc(stats.filesChanged) : 1;
  const locAdded = Number.isFinite(stats.locAdded) ? Math.trunc(stats.locAdded) : 0;
  const locDeleted = Number.isFinite(stats.locDeleted) ? Math.trunc(stats.locDeleted) : 0;
  return {
    filesChanged: Math.min(MAX_PR_PATCH_FILES, Math.max(1, filesChanged)),
    locAdded: Math.max(0, locAdded),
    locDeleted: Math.max(0, locDeleted),
  };
}


function writeJudgeSummary(path: string, summary: SanitizedPrJudgeSummary): void {
  writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

function createJudgeSummary(input: {
  submissionId: string;
  problemId: string;
  adapterId: string;
  prHeadSha: string;
  status: SanitizedPrJudgeSummary["status"];
  patchStats: SanitizedPrJudgeSummary["patchStats"];
  messages: readonly string[];
  resultSeed: string;
}): SanitizedPrJudgeSummary {
  return {
    schemaVersion: 1,
    submissionId: safePublicId(input.submissionId, "invalid-submission"),
    problemId: safePublicId(input.problemId, "invalid-problem"),
    adapterId: safePublicId(input.adapterId, "invalid-adapter"),
    prHeadSha: /^[0-9a-f]{7,40}$/i.test(input.prHeadSha) ? input.prHeadSha : "0000000",
    status: input.status,
    passFail: input.status === "passed" ? "pass" : "fail",
    runtimeMs: 0,
    patchStats: sanitizePatchStatsForSummary(input.patchStats),
    validationMessages: input.messages.slice(0, 20).map(boundedMessage),
    resultHash: `sha256:${sha256Hex(input.resultSeed)}`,
  };
}

function validateAndWriteJudgeSummary(
  path: string,
  summary: SanitizedPrJudgeSummary,
  options: { enabledProblemIds?: readonly string[]; enabledAdapterIds?: readonly string[] },
): SanitizedPrJudgeSummary {
  const validation = validateSanitizedPrJudgeSummary(summary, options);
  const writableSummary =
    validation.ok
      ? summary
      : createJudgeSummary({
          submissionId: "invalid-summary",
          problemId: "invalid-problem",
          adapterId: "invalid-adapter",
          prHeadSha: summary.prHeadSha,
          status: "invalid",
          patchStats: summary.patchStats,
          messages: validation.issues.map((entry) => `${entry.code}: Sanitized summary validation failed.`),
          resultSeed: `summary-validation:${summary.resultHash}`,
        });
  writeJudgeSummary(path, writableSummary);
  return writableSummary;
}

function problemSummary(problem: ReturnType<typeof listImplementedProblems>[number]) {
  return {
    id: problem.id,
    title: problem.title,
    benchmarkId: problem.benchmarkId,
    hostingMode: problem.hostingMode,
    tags: problem.languageFrameworkTags,
  };
}

function hasValidScoredOracleMetadata(problem: { scoringMode?: string; oracleMetadata?: { hiddenRequired: true; oracleDescriptorHash: string; originalEvidenceId: string; rerunEvidenceId: string } }): boolean {
  const oracle = problem.oracleMetadata;
  return (
    problem.scoringMode === "scored-hidden" &&
    !!oracle &&
    oracle.hiddenRequired === true &&
    /^sha256:[0-9a-f]{64}$/i.test(oracle.oracleDescriptorHash) &&
    oracle.originalEvidenceId.length > 0 &&
    oracle.rerunEvidenceId.length > 0 &&
    oracle.originalEvidenceId !== oracle.rerunEvidenceId
  );
}
function privateOracleDescriptorJson(): string | null {
  const inline = process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON;
  if (inline && inline.trim().length > 0) return inline;
  const descriptorPath = process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_PATH;
  if (descriptorPath && descriptorPath.trim().length > 0) return readFileSync(descriptorPath, "utf8");
  return null;
}

function canonicalProblemDescriptor(problemId: string, value: unknown): string | null {
  const descriptor = value as { problemId?: unknown; cases?: unknown };
  if (descriptor?.problemId !== undefined && descriptor.problemId !== problemId) return null;
  if (!Array.isArray(descriptor?.cases) || descriptor.cases.length === 0) return null;
  return JSON.stringify({ problemId, cases: descriptor.cases });
}

function privateOracleDescriptorFor(problemId: string): string | null {
  const raw = privateOracleDescriptorJson();
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const direct = canonicalProblemDescriptor(problemId, parsed);
  if (direct) return direct;

  const bundle = parsed as { descriptors?: unknown; problems?: unknown };
  if (Array.isArray(bundle.descriptors)) {
    for (const entry of bundle.descriptors) {
      const selected = canonicalProblemDescriptor(problemId, entry);
      if (selected) return selected;
    }
  }
  if (bundle.problems && typeof bundle.problems === "object" && !Array.isArray(bundle.problems)) {
    const selected = (bundle.problems as Record<string, unknown>)[problemId];
    if (selected !== undefined) return canonicalProblemDescriptor(problemId, selected);
  }
  return null;
}

function withRuntimePrivateOracle(problem: ReturnType<typeof listImplementedProblems>[number]) {
  if (hasValidScoredOracleMetadata(problem)) return problem;
  const descriptor = privateOracleDescriptorFor(problem.id);
  if (!descriptor) return problem;
  return {
    ...problem,
    scoringMode: "scored-hidden" as const,
    oracleMetadata: {
      kind: "generated-private" as const,
      hiddenRequired: true as const,
      oracleDescriptorHash: `sha256:${createHash("sha256").update(descriptor).digest("hex")}`,
      originalEvidenceId: `${problem.id}-private-original`,
      rerunEvidenceId: `${problem.id}-private-rerun`,
    },
  };
}

export function runCli(args = process.argv.slice(2)): CliRunResult {
  if (args[0] === "list") {
    return {
      ok: true,
      problemId: "all",
      patchBytes: 0,
      problems: listImplementedProblems().map(problemSummary),
    };
  }

  if (args[0] === "show") {
    const problemId = requireArg(args, 1);
    const catalogEntry = getImplementedProblemCatalog(problemId);
    if (!catalogEntry) {
      return { ok: false, problemId, patchBytes: 0, error: `Unknown problem id: ${problemId}` };
    }
    return {
      ok: true,
      problemId,
      patchBytes: 0,
      problem: {
        ...problemSummary(catalogEntry.problem),
        upstreamTaskId: catalogEntry.problem.upstreamTaskId,
      },
    };
  }

  if (args[0] === "registry") {
    return {
      ok: true,
      problemId: "registry",
      patchBytes: 0,
      registry: listAdapterRegistry().map((entry) => ({
        benchmarkId: entry.benchmark.id,
        name: entry.benchmark.name,
        licenseId: entry.benchmark.licenseId,
        status: entry.status,
        dataPolicy: entry.dataPolicy,
      })),
    };
  }

  if (args[0] === "export-recording") {
    const recordingId = requireArg(args, 1);
    const dbPath = optionalFlag(args, "--db");
    if (!dbPath) usage();
    try {
      return {
        ok: true,
        problemId: "recording",
        patchBytes: 0,
        recordingId,
        markdown: exportRecordingMarkdownFromSqlite(dbPath, recordingId),
      };
    } catch (error) {
      return {
        ok: false,
        problemId: "recording",
        patchBytes: 0,
        recordingId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (args[0] === "memory" && args[1] === "search") {
    const dbPath = optionalFlag(args, "--db");
    const errorSignature = optionalFlag(args, "--error");
    const languageFramework = optionalFlag(args, "--framework");
    if (!dbPath || !errorSignature || !languageFramework) usage();
    return {
      ok: true,
      problemId: "memory",
      patchBytes: 0,
      results: searchSqlitePublicMemory(dbPath, { errorSignature, languageFramework }),
    };
  }

  if (args[0] === "export-web-data") {
    const outDir = optionalFlag(args, "--out");
    const dbPath = optionalFlag(args, "--db");
    if (!outDir) usage();
    return {
      ok: true,
      problemId: "web-data",
      patchBytes: 0,
      exportedFiles: exportWebData(outDir, dbPath),
    };
  }

  if (args[0] === "judge-pr-submission") {
    const submissionPath = optionalFlag(args, "--submission");
    const summaryOut = optionalFlag(args, "--summary-out");
    const patchPath = optionalFlag(args, "--patch");
    const expectedPrHeadShaRaw = optionalFlag(args, "--expected-pr-head-sha") ?? process.env.AGENTOJ_EXPECTED_PR_HEAD_SHA;
    const expectedPrHeadSha =
      expectedPrHeadShaRaw && /^[0-9a-f]{40}$/i.test(expectedPrHeadShaRaw) ? expectedPrHeadShaRaw : undefined;
    if (!submissionPath || !summaryOut || !patchPath) usage();

    const patch = readPatch(patchPath);
    const judgeOptions = implementedJudgeOptions();
    let parsedPatchFiles: ParsedFilePatch[] = [];
    let patchStats: PrSubmissionEnvelope["patchStats"] = { filesChanged: 1, locAdded: 0, locDeleted: 0 };
    const patchIssueCodes: string[] = [];
    try {
      parsedPatchFiles = parseUnifiedDiff(patch);
      patchStats = patchStatsFromParsedDiff(parsedPatchFiles);
    } catch (error) {
      if (error instanceof ContractViolation) {
        patchIssueCodes.push(...error.issues.map((entry) => entry.code));
      } else {
        patchIssueCodes.push("prSubmission.patch.malformed");
      }
    }
    let envelopeInput: unknown;
    try {
      envelopeInput = JSON.parse(readFileSync(submissionPath, "utf8"));
    } catch {
      const summary = createJudgeSummary({
        submissionId: "invalid-submission",
        problemId: "unknown-problem",
        adapterId: "unknown-adapter",
        prHeadSha: expectedPrHeadSha ?? "0000000",
        status: "invalid",
        patchStats,
        messages: ["submission.json.invalid: Submission JSON could not be parsed."],
        resultSeed: `invalid-json:${expectedPrHeadSha ?? "0000000"}:${sha256Hex(patch)}`,
      });
      const writtenSummary = validateAndWriteJudgeSummary(summaryOut, summary, judgeOptions);
      return {
        ok: false,
        problemId: writtenSummary.problemId,
        patchBytes: Buffer.byteLength(patch),
        runnerStatus: "invalid",
        runnerResultHash: writtenSummary.resultHash,
        summaryPath: summaryOut,
        judgeSummary: writtenSummary,
        error: "Invalid submission JSON.",
        issues: ["submission.json.invalid"],
      };
    }

    const envelopeRecord =
      envelopeInput && typeof envelopeInput === "object" && !Array.isArray(envelopeInput)
        ? (envelopeInput as Partial<PrSubmissionEnvelope>)
        : {};
    const envelope = envelopeRecord as PrSubmissionEnvelope;
    const validation = validatePrSubmissionEnvelope(envelopeInput, judgeOptions);
    const issueCodes = [...validation.issues.map((entry) => entry.code), ...patchIssueCodes];
    if (expectedPrHeadShaRaw && !expectedPrHeadSha) issueCodes.push("prSubmission.prHeadSha.expectedInvalid");
    if (expectedPrHeadSha && envelope.prHeadSha !== expectedPrHeadSha) issueCodes.push("prSubmission.prHeadSha.mismatch");
    const summaryPrHeadSha = expectedPrHeadSha ?? envelope.prHeadSha ?? "0000000";
    if (patchIssueCodes.length === 0) issueCodes.push(...validateEnvelopeFilesAgainstPatch(envelopeRecord, parsedPatchFiles));
    const actualPatchSha256 = `sha256:${sha256Hex(patch)}`;
    const actualPatchBytes = Buffer.byteLength(patch);
    if (envelope.patchSha256 !== actualPatchSha256) issueCodes.push("prSubmission.patchSha256.mismatch");
    if (envelope.patchBytes !== actualPatchBytes) issueCodes.push("prSubmission.patchBytes.mismatch");
    if (
      envelope.patchStats?.filesChanged !== patchStats.filesChanged ||
      envelope.patchStats?.locAdded !== patchStats.locAdded ||
      envelope.patchStats?.locDeleted !== patchStats.locDeleted
    ) {
      issueCodes.push("prSubmission.patchStats.mismatch");
    }

    const catalogEntry = getImplementedProblemCatalog(envelope.problemId ?? "");
    if (!catalogEntry) issueCodes.push("prSubmission.problem.unsupported");
    if (catalogEntry && envelope.adapterId !== catalogEntry.adapter.id) issueCodes.push("prSubmission.adapter.mismatch");
    if (catalogEntry && patchIssueCodes.length === 0) {
      try {
        assertPatchTargetsAllowed(catalogEntry.problem, patch);
      } catch (error) {
        if (error instanceof ContractViolation) {
          issueCodes.push(...error.issues.map((entry) => entry.code));
        } else {
          issueCodes.push("prSubmission.patch.targetRejected");
        }
      }
    }
    const sandboxFlag = optionalFlag(args, "--sandbox");
    if (sandboxFlag !== undefined && sandboxFlag !== "docker") issueCodes.push("prSubmission.sandbox.dockerRequired");

    if (issueCodes.length > 0 || !catalogEntry) {
      const summary = createJudgeSummary({
        submissionId: envelope.id ?? "invalid-submission",
        problemId: envelope.problemId ?? "unknown-problem",
        adapterId: envelope.adapterId ?? "unknown-adapter",
        prHeadSha: summaryPrHeadSha,
        status: "invalid",
        patchStats,
        messages: Array.from(new Set(issueCodes)).map((code) => `${code}: PR submission rejected before judging.`),
        resultSeed: `invalid:${summaryPrHeadSha}:${JSON.stringify(Array.from(new Set(issueCodes)))}:${actualPatchSha256}`,
      });
      const writtenSummary = validateAndWriteJudgeSummary(summaryOut, summary, judgeOptions);
      return {
        ok: false,
        problemId: writtenSummary.problemId,
        patchBytes: actualPatchBytes,
        runnerStatus: "invalid",
        runnerResultHash: writtenSummary.resultHash,
        summaryPath: summaryOut,
        judgeSummary: writtenSummary,
        error: "PR submission rejected before judging.",
        issues: Array.from(new Set(issueCodes)),
      };
    }

    try {
      const { benchmark, adapter } = catalogEntry;
      const problem = withRuntimePrivateOracle(catalogEntry.problem);
      if (!hasValidScoredOracleMetadata(problem)) {
        const summary = createJudgeSummary({
          submissionId: envelope.id,
          problemId: problem.id,
          adapterId: adapter.id,
          prHeadSha: summaryPrHeadSha,
          status: "invalid",
          patchStats,
          messages: ["problem.scoringMode.scoredHiddenRequired: Public judging requires private scored-hidden oracle metadata."],
          resultSeed: `invalid-private-oracle:${summaryPrHeadSha}:${actualPatchSha256}`,
        });
        const writtenSummary = validateAndWriteJudgeSummary(summaryOut, summary, judgeOptions);
        return {
          ok: false,
          problemId: problem.id,
          patchBytes: actualPatchBytes,
          runnerStatus: "invalid",
          runnerResultHash: writtenSummary.resultHash,
          summaryPath: summaryOut,
          judgeSummary: writtenSummary,
          error: "PR submission rejected before judging.",
          issues: ["problem.scoringMode.scoredHiddenRequired"],
        };
      }
      const submission = createPatchSubmission(problem, envelope.id);
      const sandboxMode = "docker";
      const verification = runPatchVerification(
        {
          benchmark,
          adapter,
          problem,
          submission,
          patch,
        },
        sandboxMode,
      );
      const status: SanitizedPrJudgeSummary["status"] =
        verification.job.status === "passed"
          ? "passed"
          : verification.job.status === "infra-error"
            ? "infra-error"
            : verification.job.status === "timed-out"
              ? "timed-out"
              : "failed";
      const summary = createJudgeSummary({
        submissionId: envelope.id,
        problemId: problem.id,
        adapterId: adapter.id,
        prHeadSha: summaryPrHeadSha,
        status,
        patchStats,
        messages: [
          `judge.status.${status}: Judge completed with sanitized public metrics.`,
          `patch.apply.${verification.result.patchApplyStatus}: Patch apply status recorded without raw logs.`,
        ],
        resultSeed: `${summaryPrHeadSha}:${actualPatchSha256}:${verification.job.id}:${verification.result.resultHash}:${status}`,
      });
      const writtenSummary = validateAndWriteJudgeSummary(summaryOut, summary, judgeOptions);
      return {
        ok: status === "passed",
        problemId: problem.id,
        patchBytes: actualPatchBytes,
        runnerStatus: status,
        runnerResultHash: writtenSummary.resultHash,
        sandboxMode: verification.sandboxMode,
        oracleMode: "hidden-oracle-scored",
        summaryPath: summaryOut,
        judgeSummary: writtenSummary,
        error: status === "passed" ? undefined : "PR judge did not pass.",
        issues: undefined,
      };
    } catch (error) {
      const summary = createJudgeSummary({
        submissionId: envelope.id,
        problemId: envelope.problemId,
        adapterId: envelope.adapterId,
        prHeadSha: summaryPrHeadSha,
        status: "infra-error",
        patchStats,
        messages:
          error instanceof ContractViolation
            ? error.issues.map((entry) => `${entry.code}: Contract violation before sanitized judging completed.`)
            : ["judge.infraError: Judge failed before sanitized judging completed."],
        resultSeed: `infra-error:${summaryPrHeadSha}:${actualPatchSha256}:${error instanceof Error ? error.name : "unknown"}`,
      });
      const writtenSummary = validateAndWriteJudgeSummary(summaryOut, summary, judgeOptions);
      return {
        ok: false,
        problemId: writtenSummary.problemId,
        patchBytes: actualPatchBytes,
        runnerStatus: "infra-error",
        runnerResultHash: writtenSummary.resultHash,
        summaryPath: summaryOut,
        judgeSummary: writtenSummary,
        error: "PR judge failed before sanitized judging completed.",
        issues: summary.validationMessages,
      };
    }
  }
  if (args[0] === "serve") {
    const config = loadAgentOjApiConfig({
      ...process.env,
      AGENTOJ_DB: optionalFlag(args, "--db") ?? process.env.AGENTOJ_DB,
      AGENTOJ_PORT: optionalFlag(args, "--port") ?? process.env.AGENTOJ_PORT,
      AGENTOJ_HOST: optionalFlag(args, "--host") ?? process.env.AGENTOJ_HOST,
    });
    return {
      ok: true,
      problemId: "api",
      patchBytes: 0,
      api: {
        dbPath: config.dbPath,
        host: config.host,
        port: config.port,
        runnerMode: config.runnerMode,
      },
    };
  }
  if (args[0] !== "run") usage();
  const problemId = requireArg(args, 1);
  const patchPath = optionalFlag(args, "--patch");
  if (!patchPath) usage();
  const outDir = optionalFlag(args, "--out-dir");
  const dbPath = optionalFlag(args, "--db");
  const sandboxMode = optionalFlag(args, "--sandbox") === "docker" ? "docker" : "local";

  try {
    validateImplementedAdapterSeeds();
    const catalogEntry = getImplementedProblemCatalog(problemId);
    if (!catalogEntry) throw new Error(`Unknown problem id: ${problemId}`);
    const { benchmark, adapter } = catalogEntry;
    const problem = withRuntimePrivateOracle(catalogEntry.problem);

    const patch = readPatch(patchPath);
    const baseSubmission = createPatchSubmission(problem, patchSeed(problem.id, patch));
    const submission = hasValidScoredOracleMetadata(problem) ? baseSubmission : { ...baseSubmission, visibility: "private" as const };
    const verification = runPatchVerification(
      {
        benchmark,
        adapter,
        problem,
        submission,
        patch,
      },
      sandboxMode,
    );

    if (
      verification.job.status !== "passed" ||
      verification.result.passFail !== "pass" ||
      verification.result.patchApplyStatus !== "clean" ||
      verification.result.exitCode !== 0
    ) {
      const failed = createFailedRunBundle({
        benchmark,
        adapter,
        problem,
        submission,
        runnerJob: verification.job,
        runnerResult: verification.result,
        error: verification.stderr || "Verification failed.",
      });
      const dbPersisted = dbPath ? persistFailedRunToSqlite(dbPath, failed) : undefined;
      return {
        ok: false,
        problemId,
        patchBytes: Buffer.byteLength(patch),
        persistedDbPath: dbPersisted?.path,
        runnerStatus: verification.job.status,
        runnerResultHash: verification.result.resultHash,
        sandboxMode: verification.sandboxMode,
        oracleMode: "public-fixture-demo",
        error: failed.error,
      };
    }

    const catalog = {
      benchmark,
      adapter,
      hostedProblem: problem,
      adapterOnlyProblem: problem,
    };
    const recording = createSolutionRecording(catalog, submission, verification);

    if (!hasValidScoredOracleMetadata(problem) || verification.job.scoringStatus !== "scored" || verification.job.sandboxMode !== "docker") {
      return {
        ok: true,
        problemId,
        patchBytes: Buffer.byteLength(patch),
        recordingId: recording.id,
        runnerStatus: verification.job.status,
        runnerResultHash: verification.result.resultHash,
        sandboxMode: verification.sandboxMode,
        oracleMode: "public-fixture-demo",
      };
    }

    const rerun = runPatchVerification(
      {
        benchmark,
        adapter,
        problem,
        submission,
        patch,
        runLabel: "rerun",
      },
      "docker",
    );
    const evidence = runAutomaticCheck(recording, rerun);
    const review = approveRecording(recording, "cli-trusted-reviewer");
    const publicMemory = promoteToPublicMemory(recording, evidence, review);
    const leaderboard = createLeaderboardEntry(submission, verification);
    const bundle = {
      ...createRunBundle({
        benchmark,
        adapter,
        problem,
        submission,
        runnerJob: verification.job,
        runnerResult: verification.result,
        recording,
        evidence,
        review,
        publicMemory,
        leaderboard,
      }),
      rerunRunnerJob: rerun.job,
      rerunRunnerResult: rerun.result,
    };

    const persisted = outDir ? appendRunBundle(outDir, bundle) : undefined;
    const dbPersisted = dbPath ? persistRunBundleToSqlite(dbPath, bundle) : undefined;

    return {
      ok: true,
      problemId,
      patchBytes: Buffer.byteLength(patch),
      recordingId: recording.id,
      leaderboardEntryId: leaderboard.id,
      publicMemoryLink: publicMemory.publicSlug,
      evidenceHash: evidence.evidenceHash,
      persistedRunPath: persisted?.path,
      persistedRunLine: persisted?.lineNumber,
      persistedDbPath: dbPersisted?.path,
      runnerStatus: verification.job.status,
      runnerResultHash: verification.result.resultHash,
      sandboxMode: verification.sandboxMode,
      oracleMode: "hidden-oracle-scored",
    };
  } catch (error) {
    if (error instanceof ContractViolation) {
      return {
        ok: false,
        problemId,
        patchBytes: 0,
        error: error.message,
        issues: error.issues.map((issue) => issue.code),
      };
    }

    return {
      ok: false,
      problemId,
      patchBytes: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "serve") {
    const cliArgs = process.argv.slice(2);
    const config = loadAgentOjApiConfig({
      ...process.env,
      AGENTOJ_DB: optionalFlag(cliArgs, "--db") ?? process.env.AGENTOJ_DB,
      AGENTOJ_PORT: optionalFlag(cliArgs, "--port") ?? process.env.AGENTOJ_PORT,
      AGENTOJ_HOST: optionalFlag(cliArgs, "--host") ?? process.env.AGENTOJ_HOST,
    });
    startAgentOjServer(config);
  } else {
    const result = runCli();
    console.log(JSON.stringify(process.argv[2] === "judge-pr-submission" ? result.judgeSummary : result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }
}
