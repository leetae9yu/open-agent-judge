import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allowedProblemHostingModes,
  benchmarkExecutionPolicyFor,
  canPromoteToPublicMemory,
  isLeaderboardEligible,
  validateAdapter,
  validateBenchmark,
  validateMcpSearchQuery,
  validateMcpSearchResult,
  validateMcpToolDefinition,
  validateProblem,
  validatePrSubmissionEnvelope,
  validateSanitizedPrJudgeSummary,
  selectCanonicalPrivateOracleDescriptor,
  swebenchDescriptorCacheKey,
  validatePrivateOracleDescriptor,
  validateBenchmarkResources,
  validateBenchmarkExecutionRequest,
  type Adapter,
  type Benchmark,
  type EvidenceLedger,
  type LeaderboardEntry,
  type McpToolDefinition,
  type Problem,
  type ReviewGate,
  type RunnerResult,
  type SolutionRecording,
  type PrSubmissionEnvelope,
  type SanitizedPrJudgeSummary,
} from "../src/index.ts";

const approvedBenchmark: Benchmark = {
  id: "humaneval",
  name: "HumanEval",
  upstreamUrl: "https://github.com/openai/human-eval",
  upstreamCommitOrVersion: "abc123",
  licenseId: "MIT",
  legalStatus: "approved",
  redistributionRights: "clear",
  defaultHostingMode: "hosted",
};

const adapter: Adapter = {
  id: "humaneval-python",
  benchmarkId: "humaneval",
  adapterVersion: "1.0.0",
  fetchStrategy: "upstream-checkout",
  judgeCommand: ["python", "-m", "pytest"],
  verificationCommands: [["python", "-m", "pytest", "tests/test_sample.py"]],
  supportedHostingModes: ["hosted", "adapter-only"],
  dockerImageDigest: "python@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  defaultResources: {
    timeoutSeconds: 60,
    cpuCores: 1,
    memoryMb: 512,
    networkPolicy: "blocked",
  },
};

const problem: Problem = {
  id: "humaneval-001",
  benchmarkId: "humaneval",
  adapterId: "humaneval-python",
  upstreamTaskId: "HumanEval/1",
  title: "Sample problem",
  languageFrameworkTags: ["python"],
  hostingMode: "hosted",
  enabled: true,
  editableFilePaths: ["solution.py"],
};

const recording: SolutionRecording = {
  id: "rec-1",
  submissionId: "sub-1",
  problemId: "humaneval-001",
  benchmarkId: "humaneval",
  upstreamCommit: "abc123",
  dockerImageDigest: adapter.dockerImageDigest,
  resources: adapter.defaultResources,
  finalPatchSha256: "patchhash",
  passFail: "pass",
  locDelta: { added: 10, deleted: 2 },
  summary: "Fixed boundary handling.",
  rootCause: "The implementation skipped the empty input edge case.",
  fixDescription: "Added explicit empty-input handling before iteration.",
  verificationCommands: adapter.verificationCommands,
  scoringStatus: "scored",
  originalJobId: "job-original-1",
  originalResultId: "result-original-1",
  originalResultHash: "result-hash-original",
  oracleDescriptorHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  evidenceLedgerId: "ledger-1",
  schemaVersion: 1,
  immutable: true,
};

const evidence: EvidenceLedger = {
  id: "ledger-1",
  recordingId: "rec-1",
  requiredFieldCheck: "pass",
  patchCleanApplyCheck: "pass",
  verificationExitZeroCheck: "pass",
  sandboxRerunCheck: "pass",
  rerunJobId: "job-rerun-1",
  originalJobId: "job-original-1",
  originalResultId: "result-original-1",
  originalResultHash: "result-hash-original",
  rerunResultId: "result-rerun-1",
  rerunResultHash: "result-hash-rerun",
  oracleDescriptorHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  checkerVersion: "1.0.0",
  evidenceHash: "evidencehash",
};

const review: ReviewGate = {
  id: "review-1",
  recordingId: "rec-1",
  automaticCheckStatus: "pass",
  trustedReviewerApprovalStatus: "approved",
  reviewerId: "reviewer-1",
};

const validPrSubmissionEnvelope: PrSubmissionEnvelope = {
  schemaVersion: 1,
  id: "pr-submission-1",
  problemId: "humaneval-001",
  adapterId: "humaneval-python",
  prHeadSha: "0123456789abcdef0123456789abcdef01234567",
  patchSha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  patchBytes: 2048,
  patchStats: {
    filesChanged: 1,
    locAdded: 10,
    locDeleted: 2,
  },
  files: [{ path: "solution.py", changeType: "modify", gitMode: "100644", byteSize: 512, isBinary: false, isSymlink: false }],
  publicSubmission: true,
};

const validJudgeSummary: SanitizedPrJudgeSummary = {
  schemaVersion: 1,
  submissionId: "pr-submission-1",
  problemId: "humaneval-001",
  adapterId: "humaneval-python",
  prHeadSha: "0123456789abcdef0123456789abcdef01234567",
  status: "passed",
  passFail: "pass",
  runtimeMs: 1234,
  patchStats: {
    filesChanged: 1,
    locAdded: 10,
    locDeleted: 2,
  },
  validationMessages: ["Judge completed with sanitized public metrics."],
  resultHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
};

const enabledPrJudgeCatalog = {
  enabledProblemIds: ["humaneval-001"],
  enabledAdapterIds: ["humaneval-python"],
  benchmarkId: "humaneval",
};

describe("PR submission and judge-summary trust boundaries", () => {
  it("accepts a bounded public PR submission envelope and sanitized summary", () => {
    assert.equal(
      validatePrSubmissionEnvelope(validPrSubmissionEnvelope, enabledPrJudgeCatalog).ok,
      true,
    );
    assert.equal(validateSanitizedPrJudgeSummary(validJudgeSummary, enabledPrJudgeCatalog).ok, true);
  });
  it("applies benchmark-specific submission and execution policies", () => {
    const quixbugsPolicy = benchmarkExecutionPolicyFor("quixbugs");
    assert.equal(quixbugsPolicy?.maxPatchBytes, 150_000);
    assert.equal(quixbugsPolicy?.maxPatchFiles, 10);
    assert.equal(quixbugsPolicy?.maxFileBytes, 75_000);
    assert.deepEqual(quixbugsPolicy?.resources, { timeoutSeconds: 120, cpuCores: 1, memoryMb: 1024, networkPolicy: "blocked" });

    const swePolicy = benchmarkExecutionPolicyFor("swe-bench-lite");
    assert.equal(swePolicy?.maxPatchBytes, 500_000);
    assert.equal(swePolicy?.maxPatchFiles, 50);
    assert.equal(swePolicy?.maxWorkers, 1);
    assert.equal(swePolicy?.maintainerTriggeredOnly, true);
    assert.equal(swePolicy?.explicitPrHeadShaRequired, true);
    assert.equal(swePolicy?.allowlistedInstanceRequired, true);
    assert.equal(swePolicy?.artifactRetentionDays, 7);
    assert.deepEqual(swePolicy?.cacheKeyComponents, ["harnessCommit", "datasetRevision", "harnessImageDigest"]);
    assert.deepEqual(swePolicy?.resources, { timeoutSeconds: 2700, cpuCores: 2, memoryMb: 6144, networkPolicy: "blocked" });

    const quixbugsEnvelope: PrSubmissionEnvelope = {
      ...validPrSubmissionEnvelope,
      problemId: "quixbugs-python-bitcount",
      adapterId: "quixbugs-python",
      patchBytes: 125_000,
      patchStats: { filesChanged: 8, locAdded: 10, locDeleted: 2 },
      files: Array.from({ length: 8 }, (_, index) => ({
        path: `python_programs/file_${index}.py`,
        changeType: "modify",
        gitMode: "100644",
        byteSize: 70_000,
        isBinary: false,
        isSymlink: false,
      })),
    };
    assert.equal(
      validatePrSubmissionEnvelope(quixbugsEnvelope, {
        enabledProblemIds: ["quixbugs-python-bitcount"],
        enabledAdapterIds: ["quixbugs-python"],
        benchmarkId: "quixbugs",
      }).ok,
      true,
    );

    const oversizedQuixbugs = validatePrSubmissionEnvelope(
      {
        ...quixbugsEnvelope,
        patchBytes: 150_001,
        patchStats: { ...quixbugsEnvelope.patchStats, filesChanged: 11 },
        files: Array.from({ length: 11 }, (_, index) => ({
          path: `python_programs/file_${index}.py`,
          changeType: "modify",
          gitMode: "100644",
          byteSize: 75_001,
          isBinary: false,
          isSymlink: false,
        })),
      },
      {
        enabledProblemIds: ["quixbugs-python-bitcount"],
        enabledAdapterIds: ["quixbugs-python"],
        benchmarkId: "quixbugs",
      },
    );
    const oversizedCodes = oversizedQuixbugs.issues.map((entry) => entry.code).join("\n");
    assert.match(oversizedCodes, /prSubmission\.patchBytes\.bounds/);
    assert.match(oversizedCodes, /prSubmission\.filesChanged\.bounds/);
    assert.match(oversizedCodes, /prSubmission\.files\.tooMany/);
    assert.match(oversizedCodes, /prSubmission\.file\.byteSize\.bounds/);

    assert.equal(validateBenchmarkResources("swe-bench-verified", { timeoutSeconds: 2700, cpuCores: 2, memoryMb: 6144, networkPolicy: "blocked" }).ok, true);
    assert.match(validateBenchmarkResources("swe-bench-verified", { timeoutSeconds: 60, cpuCores: 2, memoryMb: 6144, networkPolicy: "blocked" }).issues.map((entry) => entry.code).join("\n"), /benchmarkPolicy\.timeout\.mismatch/);

    const sweGoodContext = {
      benchmarkId: "swe-bench-lite",
      resources: { timeoutSeconds: 2700, cpuCores: 2, memoryMb: 6144, networkPolicy: "blocked" },
      trigger: "workflow_dispatch" as const,
      prHeadSha: "0123456789abcdef0123456789abcdef01234567",
      instanceId: "django__django-12345",
      allowedInstanceIds: ["django__django-12345"],
      maxWorkers: 1,
      artifactRetentionDays: 7,
      harnessCommit: "123456abcdef",
      datasetRevision: "rev-1",
      harnessImageDigest: "swebench/harness@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      cacheKey: swebenchDescriptorCacheKey({
        harnessCommit: "123456abcdef",
        datasetRevision: "rev-1",
        harnessImageDigest: "swebench/harness@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      }),
    };
    assert.equal(validateBenchmarkExecutionRequest(sweGoodContext).ok, true);

    const sweBadCodes = validateBenchmarkExecutionRequest({
      ...sweGoodContext,
      trigger: "pull_request",
      prHeadSha: "",
      instanceId: "unlisted",
      maxWorkers: 2,
      artifactRetentionDays: 90,
      cacheKey: "stale-cache",
    }).issues.map((entry) => entry.code).join("\n");
    assert.match(sweBadCodes, /benchmarkPolicy\.trigger\.maintainerRequired/);
    assert.match(sweBadCodes, /benchmarkPolicy\.prHeadSha\.required/);
    assert.match(sweBadCodes, /benchmarkPolicy\.instance\.allowlist/);
    assert.match(sweBadCodes, /benchmarkPolicy\.maxWorkers\.mismatch/);
    assert.match(sweBadCodes, /benchmarkPolicy\.artifactRetention\.mismatch/);
    assert.match(sweBadCodes, /benchmarkPolicy\.cacheKey\.mismatch/);

    const quixbugsOverLimitSummary: SanitizedPrJudgeSummary = {
      ...validJudgeSummary,
      problemId: "quixbugs-python-bitcount",
      adapterId: "quixbugs-python",
      patchStats: { filesChanged: 11, locAdded: 1, locDeleted: 0 },
    };
    assert.match(
      validateSanitizedPrJudgeSummary(quixbugsOverLimitSummary, {
        enabledProblemIds: ["quixbugs-python-bitcount"],
        enabledAdapterIds: ["quixbugs-python"],
        benchmarkId: "quixbugs",
      }).issues.map((entry) => entry.code).join("\n"),
      /prJudgeSummary\.filesChanged\.bounds/,
    );

    const sweMaxFilesSummary: SanitizedPrJudgeSummary = {
      ...validJudgeSummary,
      problemId: "swe-bench-lite-django-12345",
      adapterId: "swebench-lite",
      patchStats: { filesChanged: 50, locAdded: 1, locDeleted: 0 },
    };
    assert.equal(
      validateSanitizedPrJudgeSummary(sweMaxFilesSummary, {
        enabledProblemIds: ["swe-bench-lite-django-12345"],
        enabledAdapterIds: ["swebench-lite"],
        benchmarkId: "swe-bench-lite",
      }).ok,
      true,
    );
  });

  it("rejects disabled problems, oversized patches, unsupported files, and path escapes", () => {
    const invalid: PrSubmissionEnvelope = {
      ...validPrSubmissionEnvelope,
      problemId: "disabled-problem",
      patchBytes: 100_001,
      patchStats: { ...validPrSubmissionEnvelope.patchStats, filesChanged: 3 },
      files: [
        { path: "solution.py", changeType: "modify", gitMode: "100644", byteSize: 512, isBinary: false, isSymlink: false },
        { path: "../outside.py", changeType: "modify", gitMode: "100644", byteSize: 512, isBinary: false, isSymlink: false },
        { path: "fixtures/humaneval-001/screenshot.png", changeType: "add", gitMode: "100644", byteSize: 512, isBinary: false, isSymlink: false },
      ],
    };
    const result = validatePrSubmissionEnvelope(invalid, enabledPrJudgeCatalog);
    assert.equal(result.ok, false);
    const codes = result.issues.map((entry) => entry.code).join("\n");
    assert.match(codes, /prSubmission\.problem\.disabled/);
    assert.match(codes, /prSubmission\.patchBytes\.bounds/);
    assert.match(codes, /prSubmission\.file\.pathUnsafe/);
    assert.match(codes, /prSubmission\.file\.extensionUnsupported/);
  });

  it("requires explicit enabled problem and adapter allowlists for PR judging", () => {
    const envelopeResult = validatePrSubmissionEnvelope(validPrSubmissionEnvelope);
    assert.equal(envelopeResult.ok, false);
    assert.match(envelopeResult.issues.map((entry) => entry.code).join("\n"), /prSubmission\.problemAllowlist\.required/);
    assert.match(envelopeResult.issues.map((entry) => entry.code).join("\n"), /prSubmission\.adapterAllowlist\.required/);

    const summaryResult = validateSanitizedPrJudgeSummary(validJudgeSummary);
    assert.equal(summaryResult.ok, false);
    assert.match(summaryResult.issues.map((entry) => entry.code).join("\n"), /prJudgeSummary\.problemAllowlist\.required/);
    assert.match(summaryResult.issues.map((entry) => entry.code).join("\n"), /prJudgeSummary\.adapterAllowlist\.required/);
  });

  it("rejects binary patches, symlink escapes, unsafe file modes, and oversized files", () => {
    const invalid: PrSubmissionEnvelope = {
      ...validPrSubmissionEnvelope,
      patchStats: { ...validPrSubmissionEnvelope.patchStats, filesChanged: 2 },
      files: [
        { path: "solution.py", changeType: "modify", gitMode: "100644", byteSize: 50_001, isBinary: true, isSymlink: false },
        { path: "fixtures/humaneval-001/link.py", changeType: "add", gitMode: "120000", byteSize: 6, isBinary: false, isSymlink: true },
      ],
    };
    const result = validatePrSubmissionEnvelope(invalid, enabledPrJudgeCatalog);
    assert.equal(result.ok, false);
    const codes = result.issues.map((entry) => entry.code).join("\n");
    assert.match(codes, /prSubmission\.file\.byteSize\.bounds/);
    assert.match(codes, /prSubmission\.file\.binary\.forbidden/);
    assert.match(codes, /prSubmission\.file\.modeUnsafe/);
    assert.match(codes, /prSubmission\.file\.symlink\.forbidden/);
  });

  it("rejects raw patch, raw reasoning, stdout, stderr, and secret-like public payloads", () => {
    const unsafeEnvelope = {
      ...validPrSubmissionEnvelope,
      patchText: "diff --git a/solution.py b/solution.py",
      rawChainOfThought: "hidden reasoning",
    } as never as PrSubmissionEnvelope;
    const envelopeResult = validatePrSubmissionEnvelope(unsafeEnvelope, enabledPrJudgeCatalog);
    assert.equal(envelopeResult.ok, false);
    assert.match(envelopeResult.issues.map((entry) => entry.code).join("\n"), /publicPayload\.(key|text)\.forbidden/);

    const unsafeSummary = {
      ...validJudgeSummary,
      status: "failed",
      passFail: "fail",
      stdout: "stdout SHOULD_NOT_LEAK",
      validationMessages: ["stderr contained token=abc123"],
    } as never as SanitizedPrJudgeSummary;
    const summaryResult = validateSanitizedPrJudgeSummary(unsafeSummary, enabledPrJudgeCatalog);
    assert.equal(summaryResult.ok, false);
    assert.match(summaryResult.issues.map((entry) => entry.code).join("\n"), /publicPayload\.(key|text)\.forbidden/);
  });
  it("rejects patch fragments and raw log-only text in public judge summaries", () => {
    for (const message of [
      "+ return xs[0]",
      "- removed_line",
      "--- a/solution.py",
      "index 1111111..2222222 100644",
      "+ import os",
      "- old_value",
      "+++ b/solution.py",
      "return missing",
      "SHOULD_NOT_LEAK_PATCH",
      "Ran 1 test",
      "OK",
      "Traceback (most recent call last):",
      "AssertionError: hidden failure",
    ]) {
      const result = validateSanitizedPrJudgeSummary(
        {
          ...validJudgeSummary,
          status: "failed",
          passFail: "fail",
          validationMessages: [message],
        },
        enabledPrJudgeCatalog,
      );
      assert.equal(result.ok, false, message);
      assert.match(result.issues.map((entry) => entry.code).join("\n"), /publicPayload\.text\.forbidden/, message);
    }
  });

  it("rejects unknown summary fields and snake-case/case-varied leak aliases", () => {
    const unsafeSummary = {
      ...validJudgeSummary,
      rawPatch: "opaque base64 patch bundle",
      fullBundle: "opaque bundle",
      stdout_text: "worker output bytes",
      WorktreePath: "relative-looking path",
      databaseUrl: "sqlite:///tmp/a.db",
      Secret: "redacted",
      validationMessages: ["raw reasoning trace was omitted"],
    } as never as SanitizedPrJudgeSummary;
    const result = validateSanitizedPrJudgeSummary(unsafeSummary, enabledPrJudgeCatalog);
    assert.equal(result.ok, false);
    const codes = result.issues.map((entry) => entry.code).join("\n");
    assert.match(codes, /publicPayload\.key\.forbidden/);
    assert.match(codes, /publicPayload\.text\.forbidden/);
    assert.match(codes, /prJudgeSummary\.key\.unknown/);
  });

  it("rejects oracle, container, result-bundle, credential URL, key, JWT, and obfuscated public leaks", () => {
    const unsafeSummary = {
      ...validJudgeSummary,
      status: "failed",
      passFail: "fail",
      validationMessages: [
        "oraclePath=/srv/private/oracle/cases.json result_bundle=/tmp/results/bundle.tgz api-origin=https://judge.internal container_id=abc123",
        "https://user:pass@example.test AKIA1234567890ABCDEF ghp_123456789012345678901234567890123456 sk-1234567890abcdef eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
        "s&#101;cret=obfuscated-token",
      ],
      hiddenCases: ["case-1"],
    } as never as SanitizedPrJudgeSummary;
    const result = validateSanitizedPrJudgeSummary(unsafeSummary, enabledPrJudgeCatalog);
    assert.equal(result.ok, false);
    const codes = result.issues.map((entry) => entry.code).join("\n");
    assert.match(codes, /publicPayload\.key\.forbidden/);
    assert.match(codes, /publicPayload\.text\.forbidden/);
  });
  it("rejects raw command-hidden pytest source in public judge messages", () => {
    const unsafeSummary = {
      ...validJudgeSummary,
      status: "failed",
      passFail: "fail",
      validationMessages: [
        "from python_programs.bitcount import bitcount",
        "def test_bitcount_hidden_cases(): assert bitcount(7) == 3",
      ],
    } as SanitizedPrJudgeSummary;
    const result = validateSanitizedPrJudgeSummary(unsafeSummary, enabledPrJudgeCatalog);
    assert.equal(result.ok, false);
    assert.match(result.issues.map((entry) => entry.code).join("\n"), /publicPayload\.text\.forbidden/);
  });

  it("rejects judge summaries with pass/status mismatch or unbounded message payloads", () => {
    const invalid: SanitizedPrJudgeSummary = {
      ...validJudgeSummary,
      status: "infra-error",
      passFail: "pass",
      validationMessages: ["x".repeat(241)],
    };
    const result = validateSanitizedPrJudgeSummary(invalid, enabledPrJudgeCatalog);
    assert.equal(result.ok, false);
    const codes = result.issues.map((entry) => entry.code).join("\n");
    assert.match(codes, /prJudgeSummary\.passFail\.mismatch/);
    assert.match(codes, /prJudgeSummary\.messages\.safe/);
  });

  it("rejects malformed envelopes and summaries before field validation", () => {
    assert.match(
      validatePrSubmissionEnvelope(null).issues.map((entry) => entry.code).join("\n"),
      /prSubmission\.malformed/,
    );
    assert.match(
      validateSanitizedPrJudgeSummary(["not", "an", "object"]).issues.map((entry) => entry.code).join("\n"),
      /prJudgeSummary\.malformed/,
    );
    const malformedFiles = { ...validPrSubmissionEnvelope, files: [null] } as never as PrSubmissionEnvelope;
    assert.match(
      validatePrSubmissionEnvelope(malformedFiles, enabledPrJudgeCatalog).issues.map((entry) => entry.code).join("\n"),
      /prSubmission\.file\.malformed/,
    );
    const cyclicEnvelope = { ...validPrSubmissionEnvelope } as Record<string, unknown>;
    cyclicEnvelope.self = cyclicEnvelope;
    assert.match(
      validatePrSubmissionEnvelope(cyclicEnvelope, enabledPrJudgeCatalog).issues.map((entry) => entry.code).join("\n"),
      /publicPayload\.cycle\.forbidden/,
    );

    const cyclicSummary = { ...validJudgeSummary } as Record<string, unknown>;
    cyclicSummary.self = cyclicSummary;
    const cyclicSummaryCodes = validateSanitizedPrJudgeSummary(cyclicSummary, enabledPrJudgeCatalog)
      .issues.map((entry) => entry.code)
      .join("\n");
    assert.match(cyclicSummaryCodes, /publicPayload\.cycle\.forbidden/);
    assert.match(cyclicSummaryCodes, /prJudgeSummary\.stringify\.failed/);
  });
});

describe("catalog and adapter invariants", () => {
  it("accepts a valid permissive hosted benchmark with pinned adapter metadata", () => {
    assert.equal(validateBenchmark(approvedBenchmark).ok, true);
    assert.equal(validateAdapter(adapter, approvedBenchmark).ok, true);
    assert.equal(validateProblem(problem, approvedBenchmark, adapter).ok, true);
  });

  it("requires hidden or generated private oracle metadata before a problem can be scored", () => {
    const missingOracle: Problem = { ...problem, scoringMode: "scored-hidden" };
    const missingResult = validateProblem(missingOracle, approvedBenchmark, adapter);
    assert.equal(missingResult.ok, false);
    assert.match(missingResult.issues.map((entry) => entry.code).join("\n"), /problem\.oracleMetadata\.required/);

    const invalidOracle: Problem = {
      ...problem,
      scoringMode: "scored-hidden",
      oracleMetadata: {
        kind: "hidden-fixture",
        hiddenRequired: true,
        oracleDescriptorHash: "sha256:not-a-real-hash",
        originalEvidenceId: "same-evidence",
        rerunEvidenceId: "same-evidence",
      },
    };
    const invalidResult = validateProblem(invalidOracle, approvedBenchmark, adapter);
    assert.equal(invalidResult.ok, false);
    const invalidCodes = invalidResult.issues.map((entry) => entry.code).join("\n");
    assert.match(invalidCodes, /problem\.oracleMetadata\.descriptorHash/);
    assert.match(invalidCodes, /problem\.oracleMetadata\.rerunDistinct/);

    const scored: Problem = {
      ...problem,
      scoringMode: "scored-hidden",
      oracleMetadata: {
        kind: "generated-private",
        hiddenRequired: true,
        oracleDescriptorHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      },
    };
    assert.equal(validateProblem(scored, approvedBenchmark, adapter).ok, true);
  });
  it("validates versioned private oracle descriptors for all supported kinds", () => {
    const evidencePolicy = { originalEvidenceId: "original-evidence", rerunEvidenceId: "rerun-evidence" };
    const pythonDescriptor = {
      schemaVersion: 2,
      problemId: problem.id,
      benchmarkId: problem.benchmarkId,
      adapterId: problem.adapterId,
      upstreamTaskId: problem.upstreamTaskId,
      oracleKind: "python-function-cases",
      entryPoint: "candidate",
      cases: [{ id: "edge", args: [[1, 2, 3]], expected: 1 }],
      evidencePolicy,
    };
    const pythonTestsDescriptor = {
      schemaVersion: 2,
      problemId: "synthetic-python-tests-001",
      benchmarkId: "synthetic-benchmark",
      adapterId: "synthetic-python",
      upstreamTaskId: "Synthetic/0",
      oracleKind: "python-function-tests",
      entryPoint: "candidate",
      testSource: "def check(candidate):\n    assert candidate(2) == 3\n",
      testSourceHash: "sha256:174a32c9786992483d90068a825097e63ae9bd9860fcd5e96d1c8290976add20",
      evidencePolicy,
    };
    const commandDescriptor = {
      schemaVersion: 2,
      problemId: "quixbugs-python-001",
      benchmarkId: "quixbugs",
      adapterId: "quixbugs-python",
      upstreamTaskId: "bitcount",
      oracleKind: "command-hidden-tests",
      commandId: "pytest-hidden",
      allowedTargets: ["python_programs/bitcount.py"],
      hiddenTestBundleHash: "sha256:2c37a4c57a2251c0aec52a9d83cdec084123a8bba7092178c75f8d44d1af9721",
      expectedExitCode: 0,
      testSource: "import sys\nprint(\"ok\")\n",
      testSourceHash: "sha256:2c37a4c57a2251c0aec52a9d83cdec084123a8bba7092178c75f8d44d1af9721",
      fixtureHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      evidencePolicy,
    };
    const swebenchDescriptor = {
      schemaVersion: 2,
      problemId: "swe-bench-lite-django-001",
      benchmarkId: "swe-bench-lite",
      adapterId: "swebench-lite",
      upstreamTaskId: "django__django-12345",
      oracleKind: "swebench-upstream-harness",
      datasetName: "princeton-nlp/SWE-bench_Lite",
      datasetRevision: "rev-1",
      split: "test",
      instanceId: "django__django-12345",
      repo: "django/django",
      baseCommit: "abcdef1234567890",
      harnessCommit: "123456abcdef",
      harnessImageDigest: "swebench/harness@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      predictionJsonlSchemaHash: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      cacheKey: swebenchDescriptorCacheKey({
        harnessCommit: "123456abcdef",
        datasetRevision: "rev-1",
        harnessImageDigest: "swebench/harness@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      }),
      evidencePolicy,
    };

    assert.equal(validatePrivateOracleDescriptor(pythonDescriptor, problem).ok, true);
    assert.equal(validatePrivateOracleDescriptor(pythonTestsDescriptor).ok, true);
    assert.equal(validatePrivateOracleDescriptor(commandDescriptor).ok, true);
    assert.equal(validatePrivateOracleDescriptor(swebenchDescriptor).ok, true);
    assert.match(
      validatePrivateOracleDescriptor({ ...commandDescriptor, expectedExitCode: 1 }).issues.map((entry) => entry.code).join("\n"),
      /privateOracleDescriptor\.expectedExitCode\.unsupported/,
    );

    assert.match(
      validatePrivateOracleDescriptor({ ...swebenchDescriptor, cacheKey: "swebench-lite-rev-1-123456abcdef" }).issues.map((entry) => entry.code).join("\n"),
      /privateOracleDescriptor\.cacheKey\.mismatch/,
    );

    const invalid = validatePrivateOracleDescriptor({
      ...pythonDescriptor,
      benchmarkId: "wrong",
      evidencePolicy: { originalEvidenceId: "same", rerunEvidenceId: "same" },
      cases: [{ id: "missing-expected", args: [] }],
    }, problem);
    const invalidCodes = invalid.issues.map((entry) => entry.code).join("\n");
    assert.match(invalidCodes, /privateOracleDescriptor\.benchmarkId\.mismatch/);
    assert.match(invalidCodes, /privateOracleDescriptor\.evidencePolicy\.rerunDistinct/);
    assert.match(invalidCodes, /privateOracleDescriptor\.cases\[0\]\.expected\.required/);
  });

  it("selects canonical versioned descriptors from bundles and rejects unversioned descriptors", () => {
    const descriptor = {
      schemaVersion: 2,
      problemId: problem.id,
      benchmarkId: problem.benchmarkId,
      adapterId: problem.adapterId,
      upstreamTaskId: problem.upstreamTaskId,
      oracleKind: "python-function-cases",
      entryPoint: "candidate",
      cases: [{ id: "edge", args: [[1, 2, 3]], expected: 1 }],
      evidencePolicy: { originalEvidenceId: "original-evidence", rerunEvidenceId: "rerun-evidence" },
    };
    const selected = selectCanonicalPrivateOracleDescriptor({ problemId: problem.id, benchmarkId: problem.benchmarkId, adapterId: problem.adapterId, upstreamTaskId: problem.upstreamTaskId }, { schemaVersion: 2, descriptors: [descriptor] });
    assert.equal(selected?.canonicalJson, JSON.stringify(descriptor));

    const selectedFromProblems = selectCanonicalPrivateOracleDescriptor({ problemId: problem.id, benchmarkId: problem.benchmarkId, adapterId: problem.adapterId, upstreamTaskId: problem.upstreamTaskId }, { schemaVersion: 2, problems: { [problem.id]: descriptor } });
    assert.equal(selectedFromProblems?.canonicalJson, JSON.stringify(descriptor));

    const legacy = selectCanonicalPrivateOracleDescriptor({ problemId: problem.id }, { descriptors: [{ problemId: problem.id, cases: [{ id: "legacy", args: [[]], expected: null }] }] });
    assert.equal(legacy, null);
    assert.equal(selectCanonicalPrivateOracleDescriptor({ problemId: problem.id }, { descriptors: [descriptor] }), null);
    assert.equal(selectCanonicalPrivateOracleDescriptor({ problemId: problem.id }, { schemaVersion: 1, descriptors: [descriptor] }), null);
    assert.equal(selectCanonicalPrivateOracleDescriptor({ problemId: problem.id }, { schemaVersion: 2, problems: { [problem.id]: { problemId: problem.id, cases: [{ id: "legacy", args: [[]], expected: null }] } } }), null);
  });

  it("keeps demo-public problems separate from scored hidden oracle metadata", () => {
    const demoWithOracle: Problem = {
      ...problem,
      scoringMode: "demo-public",
      oracleMetadata: {
        kind: "hidden-fixture",
        hiddenRequired: true,
        oracleDescriptorHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      },
    };
    const result = validateProblem(demoWithOracle, approvedBenchmark, adapter);
    assert.equal(result.ok, false);
    assert.match(result.issues.map((entry) => entry.code).join("\n"), /problem\.oracleMetadata\.scoredOnly/);
  });

  it("blocks unknown legal status", () => {
    const invalid = { ...approvedBenchmark, legalStatus: "unknown" as const };
    const result = validateBenchmark(invalid);
    assert.equal(result.ok, false);
    assert.match(result.issues.map((entry) => entry.code).join("\n"), /legalStatus\.unknown/);
  });

  it("rejects non-allowlisted licenses at runtime", () => {
    const invalid = { ...approvedBenchmark, licenseId: "GPL-3.0" as never };
    const result = validateBenchmark(invalid);
    assert.equal(result.ok, false);
    assert.match(result.issues.map((entry) => entry.code).join("\n"), /license\.notPermissive/);
  });

  it("allows unclear redistribution only as adapter-only", () => {
    const adapterOnlyBenchmark: Benchmark = {
      ...approvedBenchmark,
      redistributionRights: "unclear",
      defaultHostingMode: "adapter-only",
    };
    assert.deepEqual(allowedProblemHostingModes(adapterOnlyBenchmark), ["adapter-only"]);

    const hostedProblem = { ...problem, hostingMode: "hosted" as const };
    const result = validateProblem(hostedProblem, adapterOnlyBenchmark, adapter);
    assert.equal(result.ok, false);
    assert.match(result.issues.map((entry) => entry.code).join("\n"), /hostingMode\.notAllowed/);
  });

  it("requires default blocked network for MVP adapters", () => {
    const unsafeAdapter: Adapter = {
      ...adapter,
      defaultResources: { ...adapter.defaultResources, networkPolicy: "reviewed-exception" },
    };
    const result = validateAdapter(unsafeAdapter, approvedBenchmark);
    assert.equal(result.ok, false);
    assert.match(result.issues.map((entry) => entry.code).join("\n"), /network\.blocked/);
  });

  it("rejects hosted adapter support when redistribution rights are unclear", () => {
    const adapterOnlyBenchmark: Benchmark = {
      ...approvedBenchmark,
      redistributionRights: "unclear",
      defaultHostingMode: "adapter-only",
    };
    const result = validateAdapter(adapter, adapterOnlyBenchmark);
    assert.equal(result.ok, false);
    assert.match(result.issues.map((entry) => entry.code).join("\n"), /adapter\.hosted\.redistribution/);
  });
});

describe("leaderboard versus public-memory trust boundaries", () => {
  const runnerResult: RunnerResult = {
    id: "result-1",
    jobId: "job-1",
    patchApplyStatus: "clean",
    exitCode: 0,
    passFail: "pass",
    runtimeMs: 1234,
    memoryPeakMb: null,
    stdoutRef: "stdout-hash",
    stderrRef: "stderr-hash",
    resultHash: "result-hash",
  };

  it("allows leaderboard eligibility without trusted-review public-memory promotion", () => {
    const entry: LeaderboardEntry = {
      id: "leaderboard-1",
      submissionId: "sub-1",
      problemId: "humaneval-001",
      reproducibleResult: true,
      publicMetrics: {
        passFail: "pass",
        runtimeMs: 1234,
        filesChanged: 1,
        locAdded: 10,
        locDeleted: 2,
      },
      eligibilityStatus: "eligible",
    };
    assert.equal(isLeaderboardEligible(entry, runnerResult).ok, true);
  });

  it("rejects failed or mismatched runner results for leaderboard eligibility", () => {
    const entry: LeaderboardEntry = {
      id: "leaderboard-1",
      submissionId: "sub-1",
      problemId: "humaneval-001",
      reproducibleResult: true,
      publicMetrics: {
        passFail: "pass",
        runtimeMs: 1234,
        filesChanged: 1,
        locAdded: 10,
        locDeleted: 2,
      },
      eligibilityStatus: "eligible",
    };
    const failedRunner = { ...runnerResult, passFail: "fail" as const, exitCode: 1 };
    const result = isLeaderboardEligible(entry, failedRunner);
    assert.equal(result.ok, false);
    assert.match(result.issues.map((entry) => entry.code).join("\n"), /leaderboard\.runner\.pass/);
    assert.match(result.issues.map((entry) => entry.code).join("\n"), /leaderboard\.metrics\.passFailMismatch/);
  });

  it("requires automatic check and trusted reviewer approval for public memory", () => {
    assert.equal(canPromoteToPublicMemory(recording, evidence, review).ok, true);

    const unreviewed: ReviewGate = { ...review, trustedReviewerApprovalStatus: "pending" as const };
    const result = canPromoteToPublicMemory(recording, evidence, unreviewed);
    assert.equal(result.ok, false);
    assert.match(result.issues.map((entry) => entry.code).join("\n"), /trusted\.approved/);
  });

  it("rejects public memory promotion when sandbox rerun evidence fails", () => {
    const failedEvidence = { ...evidence, sandboxRerunCheck: "fail" as const };
    const result = canPromoteToPublicMemory(recording, failedEvidence, review);
    assert.equal(result.ok, false);
    assert.match(result.issues.map((entry) => entry.code).join("\n"), /evidence\.rerun\.pass/);
  });

  it("rejects failed recordings before public memory promotion", () => {
    const failedRecording = { ...recording, passFail: "fail" as const };
    const result = canPromoteToPublicMemory(failedRecording, evidence, review);
    assert.equal(result.ok, false);
    assert.match(result.issues.map((entry) => entry.code).join("\n"), /recording\.passFail\.pass/);
  });

  it("rejects raw chain-of-thought payloads in recordings", () => {
    const rawCotRecording = { ...recording, rawChainOfThought: "hidden reasoning" } as never as SolutionRecording;
    const result = canPromoteToPublicMemory(rawCotRecording, evidence, review);
    assert.equal(result.ok, false);
    assert.match(result.issues.map((entry) => entry.code).join("\n"), /recording\.rawCot\.forbidden/);
  });

  it("requires the promoted ledger id to match recording.evidenceLedgerId", () => {
    const wrongLedger = { ...evidence, id: "ledger-2" };
    const result = canPromoteToPublicMemory(recording, wrongLedger, review);
    assert.equal(result.ok, false);
    assert.match(result.issues.map((entry) => entry.code).join("\n"), /evidence\.id\.mismatch/);
  });
});

describe("read-only MCP boundary", () => {
  it("accepts constrained MCP search input", () => {
    const result = validateMcpSearchQuery({
      errorSignature: "TypeError: cannot read property",
      languageFramework: "typescript/node",
      stackTraceSummary: "Fails in adapter validation.",
    });
    assert.equal(result.ok, true);
  });

  it("rejects raw source or mutation-like MCP inputs", () => {
    const result = validateMcpSearchQuery({
      errorSignature: "pytest import error",
      languageFramework: "python/pytest",
      sourceCode: "def secret(): pass",
      applyPatch: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.issues.filter((entry) => entry.code === "mcp.query.key.forbidden").length, 2);
  });

  it("accepts public links and action checklists as MCP output", () => {
    const result = validateMcpSearchResult({
      publicRecordingLink: "https://agentoj.example/recordings/rec-1",
      actionChecklist: ["Check the failing adapter validation.", "Rerun the pinned verification command."],
      sourceRecordingIds: ["rec-1"],
      applicabilityExplanation: "Same framework and error signature.",
    });
    assert.equal(result.ok, true);
  });
  it("rejects public-output leaks inside otherwise allowed MCP result fields", () => {
    const result = validateMcpSearchResult({
      publicRecordingLink: "/recordings/rec-1",
      actionChecklist: ["Do not paste stdout here", "+ import os", "token=abc123456789abcdef"],
      sourceRecordingIds: ["rec-1"],
      applicabilityExplanation: "Traceback (most recent call last): /tmp/private/oracle/cases.json",
    });
    assert.equal(result.ok, false);
    assert.match(result.issues.map((entry) => entry.code).join("\n"), /publicPayload\.text\.forbidden/);

    const unsafeLink = validateMcpSearchResult({
      publicRecordingLink: "https://user:pass@agentoj.example/recordings/rec-1?token=abc123456789abcdef",
      actionChecklist: ["Check the safe public summary."],
      sourceRecordingIds: ["rec-1"],
      applicabilityExplanation: "Same framework and error signature.",
    });
    assert.equal(unsafeLink.ok, false);
    assert.match(unsafeLink.issues.map((entry) => entry.code).join("\n"), /mcp\.result\.link\.required/);
  });

  it("rejects nested or blank MCP result payloads under allowed keys", () => {
    const result = validateMcpSearchResult({
      publicRecordingLink: "file:///tmp/private-recording.json",
      actionChecklist: ["", { mutate: "apply patch" }],
      sourceRecordingIds: ["rec-1"],
      applicabilityExplanation: "Same framework and error signature.",
    });
    assert.equal(result.ok, false);
    assert.match(result.issues.map((entry) => entry.code).join("\n"), /mcp\.result\.link\.required/);
    assert.match(result.issues.map((entry) => entry.code).join("\n"), /mcp\.result\.checklist\.required/);
  });

  it("rejects MCP tool definitions that expose forbidden IO keys", () => {
    const tool: McpToolDefinition = {
      name: "search_troubleshooting_memory",
      readOnly: true,
      allowedInputKeys: ["errorSignature", "languageFramework", "stackTraceSummary", "patch" as never],
      allowedOutputKeys: ["publicRecordingLink", "actionChecklist", "sourceRecordingIds", "applicabilityExplanation"],
    };
    const result = validateMcpToolDefinition(tool);
    assert.equal(result.ok, false);
    assert.match(result.issues.map((entry) => entry.code).join("\n"), /mcp\.tool\.inputKey/);
  });

  it("rejects underspecified MCP tool definitions", () => {
    const tool: McpToolDefinition = {
      name: "",
      readOnly: true,
      allowedInputKeys: ["errorSignature"],
      allowedOutputKeys: ["publicRecordingLink"],
    };
    const result = validateMcpToolDefinition(tool);
    assert.equal(result.ok, false);
    assert.match(result.issues.map((entry) => entry.code).join("\n"), /mcp\.tool\.name\.required/);
    assert.match(result.issues.map((entry) => entry.code).join("\n"), /mcp\.tool\.inputRequired/);
    assert.match(result.issues.map((entry) => entry.code).join("\n"), /mcp\.tool\.outputRequired/);
  });
});
