import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allowedProblemHostingModes,
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
};

describe("PR submission and judge-summary trust boundaries", () => {
  it("accepts a bounded public PR submission envelope and sanitized summary", () => {
    assert.equal(
      validatePrSubmissionEnvelope(validPrSubmissionEnvelope, enabledPrJudgeCatalog).ok,
      true,
    );
    assert.equal(validateSanitizedPrJudgeSummary(validJudgeSummary, enabledPrJudgeCatalog).ok, true);
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
        originalEvidenceId: "original-run-evidence",
        rerunEvidenceId: "independent-rerun-evidence",
      },
    };
    assert.equal(validateProblem(scored, approvedBenchmark, adapter).ok, true);
  });

  it("keeps demo-public problems separate from scored hidden oracle metadata", () => {
    const demoWithOracle: Problem = {
      ...problem,
      scoringMode: "demo-public",
      oracleMetadata: {
        kind: "hidden-fixture",
        hiddenRequired: true,
        oracleDescriptorHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        originalEvidenceId: "original-run-evidence",
        rerunEvidenceId: "independent-rerun-evidence",
      },
    };
    const result = validateProblem(demoWithOracle, approvedBenchmark, adapter);
    assert.equal(result.ok, false);
    assert.match(result.issues.map((entry) => entry.code).join("\n"), /problem\.oracleMetadata\.demoForbidden/);
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
