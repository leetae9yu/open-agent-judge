export type LicenseId =
  | "MIT"
  | "Apache-2.0"
  | "BSD-2-Clause"
  | "BSD-3-Clause";

export type LegalStatus = "approved" | "unknown" | "rejected";
export type RedistributionRights = "clear" | "unclear" | "forbidden";
export type HostingMode = "hosted" | "adapter-only";
export type NetworkPolicy = "blocked" | "reviewed-exception";
export type ReviewStatus = "pending" | "approved" | "rejected";
export type CheckStatus = "pass" | "fail";
export type RunnerStatus = "queued" | "running" | "passed" | "failed" | "timed-out" | "infra-error";
export type ScoringStatus = "demo" | "scored";
export type SandboxExecutionMode = "local" | "docker";

export interface Benchmark {
  id: string;
  name: string;
  upstreamUrl: string;
  upstreamCommitOrVersion: string;
  licenseId: LicenseId;
  legalStatus: LegalStatus;
  redistributionRights: RedistributionRights;
  defaultHostingMode: HostingMode;
}

export interface ResourceLimits {
  timeoutSeconds: number;
  cpuCores: number;
  memoryMb: number;
  networkPolicy: NetworkPolicy;
}

export interface Adapter {
  id: string;
  benchmarkId: string;
  adapterVersion: string;
  fetchStrategy: "upstream-checkout" | "hosted-fixture";
  judgeCommand: readonly string[];
  verificationCommands: readonly (readonly string[])[];
  supportedHostingModes: readonly HostingMode[];
  dockerImageDigest: string;
  defaultResources: ResourceLimits;
}

export type ProblemScoringMode = "demo-public" | "scored-hidden";
export type OracleMetadataKind = "hidden-fixture" | "generated-private";

export interface ProblemOracleMetadata {
  kind: OracleMetadataKind;
  hiddenRequired: true;
  oracleDescriptorHash: string;
  originalEvidenceId: string;
  rerunEvidenceId: string;
}

export interface Problem {
  id: string;
  benchmarkId: string;
  adapterId: string;
  upstreamTaskId: string;
  title: string;
  languageFrameworkTags: readonly string[];
  hostingMode: HostingMode;
  enabled: boolean;
  editableFilePaths: readonly string[];
  scoringMode?: ProblemScoringMode;
  oracleMetadata?: ProblemOracleMetadata;
}

export interface PublicMetrics {
  passFail: "pass" | "fail";
  runtimeMs: number;
  filesChanged: number;
  locAdded: number;
  locDeleted: number;
}

export interface OptionalMetrics {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface PatchSubmission {
  id: string;
  userId: string;
  problemId: string;
  patchSha256: string;
  patchStats: {
    filesChanged: number;
    locAdded: number;
    locDeleted: number;
  };
  suppliedMetrics?: OptionalMetrics;
  visibility: "private" | "public-summary" | "public-full";
  publicMetrics: PublicMetrics;
}
export interface PrSubmissionFile {
  path: string;
  changeType: "add" | "modify" | "delete";
  gitMode: string;
  byteSize: number;
  isBinary: boolean;
  isSymlink: boolean;
}

export interface PrSubmissionEnvelope {
  schemaVersion: 1;
  id: string;
  problemId: string;
  adapterId: string;
  prHeadSha?: string;
  patchSha256: string;
  patchBytes: number;
  patchStats: {
    filesChanged: number;
    locAdded: number;
    locDeleted: number;
  };
  files: readonly PrSubmissionFile[];
  publicSubmission: true;
  rawChainOfThought?: never;
}

export type PrJudgeSummaryStatus = "passed" | "failed" | "timed-out" | "infra-error" | "invalid";

export interface SanitizedPrJudgeSummary {
  schemaVersion: 1;
  submissionId: string;
  problemId: string;
  adapterId: string;
  prHeadSha: string;
  status: PrJudgeSummaryStatus;
  passFail: "pass" | "fail";
  runtimeMs: number;
  patchStats: {
    filesChanged: number;
    locAdded: number;
    locDeleted: number;
  };
  validationMessages: readonly string[];
  resultHash: string;
  rawChainOfThought?: never;
}

export interface RunnerJob {
  id: string;
  submissionId: string;
  adapterId: string;
  upstreamCommit: string;
  dockerImageDigest: string;
  resources: ResourceLimits;
  status: RunnerStatus;
  scoringStatus: ScoringStatus;
  sandboxMode: SandboxExecutionMode;
  oracleDescriptorHash: string | null;
}

export interface RunnerResult {
  id: string;
  jobId: string;
  patchApplyStatus: "clean" | "dirty" | "failed";
  exitCode: number;
  passFail: "pass" | "fail";
  runtimeMs: number;
  memoryPeakMb: number | null;
  stdoutRef: string;
  stderrRef: string;
  resultHash: string;
}

export interface EvidenceLedger {
  id: string;
  recordingId: string;
  requiredFieldCheck: CheckStatus;
  patchCleanApplyCheck: CheckStatus;
  verificationExitZeroCheck: CheckStatus;
  sandboxRerunCheck: CheckStatus;
  rerunJobId: string;
  originalJobId: string;
  originalResultId: string;
  originalResultHash: string;
  rerunResultId: string;
  rerunResultHash: string;
  oracleDescriptorHash: string;
  checkerVersion: string;
  evidenceHash: string;
}

export interface SolutionRecording {
  id: string;
  submissionId: string;
  problemId: string;
  benchmarkId: string;
  upstreamCommit: string;
  dockerImageDigest: string;
  resources: ResourceLimits;
  finalPatchSha256: string;
  passFail: "pass" | "fail";
  locDelta: { added: number; deleted: number };
  tokenMetrics?: OptionalMetrics;
  summary: string;
  rootCause: string;
  fixDescription: string;
  verificationCommands: readonly (readonly string[])[];
  scoringStatus: ScoringStatus;
  originalJobId: string;
  originalResultId: string;
  originalResultHash: string;
  oracleDescriptorHash: string;
  evidenceLedgerId: string;
  schemaVersion: number;
  immutable: true;
  rawChainOfThought?: never;
}

export interface ReviewGate {
  id: string;
  recordingId: string;
  automaticCheckStatus: CheckStatus;
  trustedReviewerApprovalStatus: ReviewStatus;
  reviewerId?: string;
  reviewerNotes?: string;
}

export interface PublicMemoryEntry {
  id: string;
  recordingId: string;
  publicSlug: string;
  sourceChecklistCaseIds: readonly string[];
}

export interface LeaderboardEntry {
  id: string;
  submissionId: string;
  problemId: string;
  reproducibleResult: boolean;
  publicMetrics: PublicMetrics;
  eligibilityStatus: "eligible" | "ineligible";
  ineligibilityReason?: string;
}

export interface DiscussionPost {
  id: string;
  problemId: string;
  authorId: string;
  markdown: string;
  moderationState: "visible" | "hidden" | "flagged";
}

export interface TagSuggestion {
  id: string;
  targetId: string;
  targetType: "problem" | "recording";
  tag: string;
  suggestedBy: string;
  reviewerDecision: ReviewStatus;
}

export interface DifficultyVote {
  id: string;
  problemId: string;
  voterId: string;
  value: 1 | 2 | 3 | 4 | 5;
}

export interface ApprovedDifficulty {
  problemId: string;
  approvedValue: 1 | 2 | 3 | 4 | 5;
  reviewerId: string;
}

export interface McpSearchQuery {
  errorSignature: string;
  languageFramework: string;
  stackTraceSummary?: string;
}

export interface McpSearchResult {
  publicRecordingLink: string;
  actionChecklist: readonly string[];
  sourceRecordingIds: readonly string[];
  applicabilityExplanation: string;
}

export interface McpToolDefinition {
  name: string;
  readOnly: true;
  allowedInputKeys: readonly (keyof McpSearchQuery)[];
  allowedOutputKeys: readonly (keyof McpSearchResult)[];
}

export interface ValidationIssue {
  code: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}
