import type {
  Adapter,
  Benchmark,
  EvidenceLedger,
  PatchSubmission,
  Problem,
  ReviewGate,
  RunnerJob,
  RunnerResult,
  SolutionRecording,
  PublicMemoryEntry,
  ValidationIssue,
} from "./contracts/types.ts";
import {
  canPromoteToPublicMemory,
  validateAdapter,
  validateBenchmark,
  validateProblem,
  validateRecording,
} from "./contracts/validators.ts";

export type VerificationScenario = "pass" | "failed-tests" | "patch-apply-failed";

export class ContractViolation extends Error {
  readonly issues: ValidationIssue[];

  constructor(message: string, issues: ValidationIssue[]) {
    super(message);
    this.name = "ContractViolation";
    this.issues = issues;
  }
}

export interface SeededCatalog {
  benchmark: Benchmark;
  adapter: Adapter;
  hostedProblem: Problem;
  adapterOnlyProblem: Problem;
}

export interface VerificationRun {
  job: RunnerJob;
  result: RunnerResult;
}

export interface GoldenTrustSliceResult {
  catalog: SeededCatalog;
  submission: PatchSubmission;
  verification: VerificationRun;
  recording: SolutionRecording;
  evidence: EvidenceLedger;
  review: ReviewGate;
}

function assertValid(context: string, issues: ValidationIssue[]): void {
  if (issues.length > 0) throw new ContractViolation(`${context} failed validation`, issues);
}

function stableId(prefix: string, seed: string): string {
  return `${prefix}-${seed.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}`;
}

function sameResources(left: RunnerJob["resources"], right: RunnerJob["resources"]): boolean {
  return (
    left.timeoutSeconds === right.timeoutSeconds &&
    left.cpuCores === right.cpuCores &&
    left.memoryMb === right.memoryMb &&
    left.networkPolicy === right.networkPolicy
  );
}

function catalogProblem(catalog: SeededCatalog, problemId: string): Problem | null {
  for (const problem of [catalog.hostedProblem, catalog.adapterOnlyProblem]) {
    if (problem.id === problemId) return problem;
  }
  return null;
}

function canCreateScoredRecording(problem: Problem, verification: VerificationRun): boolean {
  return (
    problem.scoringMode === "scored-hidden" &&
    problem.oracleMetadata?.hiddenRequired === true &&
    problem.oracleMetadata.oracleDescriptorHash === verification.job.oracleDescriptorHash &&
    problem.oracleMetadata.originalEvidenceId !== problem.oracleMetadata.rerunEvidenceId &&
    verification.job.scoringStatus === "scored" &&
    verification.job.sandboxMode === "docker"
  );
}

function verificationMatchesSubmission(catalog: SeededCatalog, submission: PatchSubmission, verification: VerificationRun): boolean {
  return (
    verification.job.submissionId === submission.id &&
    verification.result.jobId === verification.job.id &&
    verification.job.adapterId === catalog.adapter.id &&
    verification.job.status === "passed" &&
    verification.job.upstreamCommit === catalog.benchmark.upstreamCommitOrVersion &&
    verification.job.dockerImageDigest === catalog.adapter.dockerImageDigest &&
    sameResources(verification.job.resources, catalog.adapter.defaultResources) &&
    true
  );
}


export function seedPermissiveCatalog(): SeededCatalog {
  const benchmark: Benchmark = {
    id: "humaneval",
    name: "HumanEval",
    upstreamUrl: "https://github.com/openai/human-eval",
    upstreamCommitOrVersion: "7f8c01e",
    licenseId: "MIT",
    legalStatus: "approved",
    redistributionRights: "clear",
    defaultHostingMode: "hosted",
  };

  const adapter: Adapter = {
    id: "humaneval-python",
    benchmarkId: benchmark.id,
    adapterVersion: "1.0.0",
    fetchStrategy: "upstream-checkout",
    judgeCommand: ["python", "-m", "pytest"],
    verificationCommands: [["python", "-m", "pytest", "tests/test_humaneval.py"]],
    supportedHostingModes: ["hosted", "adapter-only"],
    dockerImageDigest: "python:3.12.11-slim-bookworm@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7",
    defaultResources: {
      timeoutSeconds: 60,
      cpuCores: 1,
      memoryMb: 512,
      networkPolicy: "blocked",
    },
  };

  const hostedProblem: Problem = {
    id: "humaneval-001",
    benchmarkId: benchmark.id,
    adapterId: adapter.id,
    upstreamTaskId: "HumanEval/1",
    title: "Return the first element",
    languageFrameworkTags: ["python", "pytest"],
    hostingMode: "hosted",
    enabled: true,
    editableFilePaths: ["solution.py"],
    scoringMode: "demo-public",
  };

  const adapterOnlyProblem: Problem = {
    id: "humaneval-002-adapter-only",
    benchmarkId: benchmark.id,
    adapterId: adapter.id,
    upstreamTaskId: "HumanEval/2",
    title: "Adapter-only execution fixture",
    languageFrameworkTags: ["python", "pytest"],
    hostingMode: "adapter-only",
    enabled: true,
    editableFilePaths: ["solution.py"],
    scoringMode: "demo-public",
  };

  assertValid("benchmark", validateBenchmark(benchmark).issues);
  assertValid("adapter", validateAdapter(adapter, benchmark).issues);
  assertValid("hosted problem", validateProblem(hostedProblem, benchmark, adapter).issues);
  assertValid("adapter-only problem", validateProblem(adapterOnlyProblem, benchmark, adapter).issues);

  return { benchmark, adapter, hostedProblem, adapterOnlyProblem };
}

export function createPatchSubmission(problem: Problem, patchSeed = "passing-fix"): PatchSubmission {
  return {
    id: stableId("submission", `${problem.id}-${patchSeed}`),
    userId: "agent-user-1",
    problemId: problem.id,
    patchSha256: `sha256:${patchSeed}`,
    patchStats: {
      filesChanged: 1,
      locAdded: 8,
      locDeleted: 2,
    },
    suppliedMetrics: {
      inputTokens: 1200,
      outputTokens: 300,
      costUsd: 0.02,
    },
    visibility: "public-summary",
    publicMetrics: {
      passFail: "pass",
      runtimeMs: 1500,
      filesChanged: 1,
      locAdded: 8,
      locDeleted: 2,
    },
  };
}

export function simulateSandboxVerification(
  submission: PatchSubmission,
  adapter: Adapter,
  scenario: VerificationScenario = "pass",
  runSeed = "original",
): VerificationRun {
  const cleanPatch = scenario !== "patch-apply-failed";
  const passed = scenario === "pass";
  const job: RunnerJob = {
    id: stableId("job", `${submission.id}-${runSeed}`),
    submissionId: submission.id,
    adapterId: adapter.id,
    upstreamCommit: "7f8c01e",
    dockerImageDigest: adapter.dockerImageDigest,
    resources: adapter.defaultResources,
    status: passed ? "passed" : scenario === "failed-tests" ? "failed" : "infra-error",
    scoringStatus: "demo",
    sandboxMode: "local",
    oracleDescriptorHash: null,
  };
  const result: RunnerResult = {
    id: stableId("result", `${submission.id}-${runSeed}`),
    jobId: job.id,
    patchApplyStatus: cleanPatch ? "clean" : "failed",
    exitCode: passed ? 0 : 1,
    passFail: passed ? "pass" : "fail",
    runtimeMs: 1500,
    memoryPeakMb: null,
    stdoutRef: `stdout:${job.id}`,
    stderrRef: `stderr:${job.id}`,
    resultHash: `result:${job.id}:${scenario}:${runSeed}`,
  };

  return { job, result };
}

export function createSolutionRecording(
  catalog: SeededCatalog,
  submission: PatchSubmission,
  verification: VerificationRun,
): SolutionRecording {
  const problem = catalogProblem(catalog, submission.problemId);
  const baseValid =
    !!problem &&
    verification.result.patchApplyStatus === "clean" &&
    verification.result.passFail === "pass" &&
    verification.result.exitCode === 0 &&
    verificationMatchesSubmission(catalog, submission, verification);
  const scoredVerification = verification.job.scoringStatus === "scored";
  if (!baseValid || (scoredVerification && !canCreateScoredRecording(problem!, verification))) {
    throw new ContractViolation("only matching passing clean verification results can create solution recordings", [
      {
        code: baseValid && scoredVerification ? "recording.source.scoredOracleRequired" : "recording.source.notPassing",
        message: "Recording creation requires a matching job descriptor, clean patch application, passing verification, and valid scored oracle metadata for scored recordings.",
      },
    ]);
  }


  const recording: SolutionRecording = {
    id: stableId("recording", submission.id),
    submissionId: submission.id,
    problemId: submission.problemId,
    benchmarkId: catalog.benchmark.id,
    upstreamCommit: verification.job.upstreamCommit,
    dockerImageDigest: verification.job.dockerImageDigest,
    resources: verification.job.resources,
    finalPatchSha256: submission.patchSha256,
    passFail: verification.result.passFail,
    locDelta: {
      added: submission.patchStats.locAdded,
      deleted: submission.patchStats.locDeleted,
    },
    tokenMetrics: submission.suppliedMetrics,
    summary: "Fixed the task by applying the submitted patch and validating it in the pinned sandbox.",
    rootCause: "The original implementation missed the target edge case represented by the benchmark task.",
    fixDescription: "The patch updates the implementation and passes the adapter verification command.",
    verificationCommands: catalog.adapter.verificationCommands,
    scoringStatus: verification.job.scoringStatus,
    originalJobId: verification.job.id,
    originalResultId: verification.result.id,
    originalResultHash: verification.result.resultHash,
    oracleDescriptorHash: verification.job.oracleDescriptorHash ?? "",
    evidenceLedgerId: stableId("evidence", submission.id),
    schemaVersion: 1,
    immutable: true,
  };

  assertValid("solution recording", validateRecording(recording).issues);
  return recording;
}

export function runAutomaticCheck(recording: SolutionRecording, rerun: VerificationRun): EvidenceLedger {
  const basicPass =
    rerun.result.patchApplyStatus === "clean" &&
    rerun.result.exitCode === 0 &&
    rerun.result.passFail === "pass" &&
    rerun.result.jobId === rerun.job.id &&
    rerun.job.submissionId === recording.submissionId &&
    rerun.job.upstreamCommit === recording.upstreamCommit &&
    rerun.job.dockerImageDigest === recording.dockerImageDigest &&
    sameResources(rerun.job.resources, recording.resources);
  const scoredPass =
    basicPass &&
    rerun.job.scoringStatus === "scored" &&
    rerun.job.sandboxMode === "docker" &&
    rerun.job.oracleDescriptorHash === recording.oracleDescriptorHash &&
    rerun.job.id !== recording.originalJobId &&
    rerun.result.id !== recording.originalResultId &&
    rerun.result.resultHash !== recording.originalResultHash;
  const pass = scoredPass;
  const ledger: EvidenceLedger = {
    id: recording.evidenceLedgerId,
    recordingId: recording.id,
    requiredFieldCheck: validateRecording(recording).ok ? "pass" : "fail",
    patchCleanApplyCheck: rerun.result.patchApplyStatus === "clean" ? "pass" : "fail",
    verificationExitZeroCheck: rerun.result.exitCode === 0 ? "pass" : "fail",
    sandboxRerunCheck: pass ? "pass" : "fail",
    rerunJobId: rerun.job.id,
    originalJobId: recording.originalJobId,
    originalResultId: recording.originalResultId,
    originalResultHash: recording.originalResultHash,
    rerunResultId: rerun.result.id,
    rerunResultHash: rerun.result.resultHash,
    oracleDescriptorHash: rerun.job.oracleDescriptorHash ?? "",
    checkerVersion: "1.0.0",
    evidenceHash: `evidence:${recording.id}:${rerun.result.resultHash}`,
  };

  return ledger;
}

export function approveRecording(recording: SolutionRecording, reviewerId = "trusted-reviewer-1"): ReviewGate {
  return {
    id: stableId("review", recording.id),
    recordingId: recording.id,
    automaticCheckStatus: "pass",
    trustedReviewerApprovalStatus: "approved",
    reviewerId,
    reviewerNotes: "Verified recording has passing automatic checks and a useful post-hoc explanation.",
  };
}

export function promoteToPublicMemory(
  recording: SolutionRecording,
  evidence: EvidenceLedger,
  review: ReviewGate,
): PublicMemoryEntry {
  assertValid("public memory promotion", canPromoteToPublicMemory(recording, evidence, review).issues);

  return {
    id: stableId("public-memory", recording.id),
    recordingId: recording.id,
    publicSlug: `/recordings/${recording.id}`,
    sourceChecklistCaseIds: [stableId("checklist", recording.id)],
  };
}

export function runGoldenTrustSlice(): GoldenTrustSliceResult {
  const catalog = seedPermissiveCatalog();
  const submission = createPatchSubmission(catalog.hostedProblem);
  const verification = simulateSandboxVerification(submission, catalog.adapter, "pass");
  const recording = createSolutionRecording(catalog, submission, verification);
  const rerun = simulateSandboxVerification(submission, catalog.adapter, "pass", "rerun");
  const evidence = runAutomaticCheck(recording, rerun);
  const review = approveRecording(recording);

  return { catalog, submission, verification, recording, evidence, review };
}
