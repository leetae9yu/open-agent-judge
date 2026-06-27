import { createHash } from "node:crypto";
import type {
  Adapter,
  Benchmark,
  BenchmarkExecutionPolicy,
  EvidenceLedger,
  HostingMode,
  LeaderboardEntry,
  McpSearchQuery,
  McpSearchResult,
  McpToolDefinition,
  Problem,
  ReviewGate,
  RunnerResult,
  PatchSubmission,
  PrivateOracleDescriptor,
  PrivateOracleDescriptorKind,
  PrSubmissionEnvelope,
  PublicMetrics,
  SolutionRecording,
  SanitizedPrJudgeSummary,
  ValidationIssue,
  ValidationResult,
} from "./types.ts";

const PERMISSIVE_LICENSES = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause"]);
const ALLOWED_MCP_QUERY_KEYS = new Set(["errorSignature", "languageFramework", "stackTraceSummary"]);
const ALLOWED_MCP_RESULT_KEYS = new Set([
  "publicRecordingLink",
  "actionChecklist",
  "sourceRecordingIds",
  "applicabilityExplanation",
]);

export const PR_SUBMISSION_SCHEMA_VERSION = 1;
export const MAX_PR_PATCH_BYTES = 100_000;
export const MAX_PR_PATCH_FILES = 20;
export const MAX_PR_FILE_BYTES = 50_000;
export const MAX_SANITIZED_JUDGE_SUMMARY_BYTES = 16_384;
export const BENCHMARK_EXECUTION_POLICIES = [
  {
    benchmarkId: "humaneval",
    maxPatchBytes: 100_000,
    maxPatchFiles: 20,
    maxFileBytes: 50_000,
    resources: { timeoutSeconds: 60, cpuCores: 1, memoryMb: 512, networkPolicy: "blocked" },
  },
  {
    benchmarkId: "mbpp",
    maxPatchBytes: 100_000,
    maxPatchFiles: 20,
    maxFileBytes: 50_000,
    resources: { timeoutSeconds: 60, cpuCores: 1, memoryMb: 512, networkPolicy: "blocked" },
  },
  {
    benchmarkId: "quixbugs",
    maxPatchBytes: 150_000,
    maxPatchFiles: 10,
    maxFileBytes: 75_000,
    resources: { timeoutSeconds: 120, cpuCores: 1, memoryMb: 1024, networkPolicy: "blocked" },
  },
  {
    benchmarkId: "swe-bench-lite",
    maxPatchBytes: 500_000,
    maxPatchFiles: 50,
    maxFileBytes: 200_000,
    resources: { timeoutSeconds: 2700, cpuCores: 2, memoryMb: 6144, networkPolicy: "blocked" },
    maxWorkers: 1,
    maintainerTriggeredOnly: true,
    explicitPrHeadShaRequired: true,
    allowlistedInstanceRequired: true,
    artifactRetentionDays: 7,
    cacheKeyComponents: ["harnessCommit", "datasetRevision", "harnessImageDigest"],
  },
  {
    benchmarkId: "swe-bench-verified",
    maxPatchBytes: 500_000,
    maxPatchFiles: 50,
    maxFileBytes: 200_000,
    resources: { timeoutSeconds: 2700, cpuCores: 2, memoryMb: 6144, networkPolicy: "blocked" },
    maxWorkers: 1,
    maintainerTriggeredOnly: true,
    explicitPrHeadShaRequired: true,
    allowlistedInstanceRequired: true,
    artifactRetentionDays: 7,
    cacheKeyComponents: ["harnessCommit", "datasetRevision", "harnessImageDigest"],
  },
] as const satisfies readonly BenchmarkExecutionPolicy[];

export function benchmarkExecutionPolicyFor(benchmarkId: string): BenchmarkExecutionPolicy | undefined {
  return BENCHMARK_EXECUTION_POLICIES.find((policy) => policy.benchmarkId === benchmarkId);
}

export function defaultBenchmarkExecutionPolicy(): BenchmarkExecutionPolicy {
  return BENCHMARK_EXECUTION_POLICIES[0];
}
export function validateBenchmarkResources(benchmarkId: string, resources: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const policy = benchmarkExecutionPolicyFor(benchmarkId);
  if (!policy) {
    issues.push(issue("benchmarkPolicy.unknown", "Benchmark must have an explicit execution policy before scored judging."));
    return result(issues);
  }
  if (!resources || typeof resources !== "object" || Array.isArray(resources)) {
    issues.push(issue("benchmarkPolicy.resources.malformed", "Benchmark resources must be an object."));
    return result(issues);
  }
  const actual = resources as Partial<BenchmarkExecutionPolicy["resources"]>;
  if (actual.timeoutSeconds !== policy.resources.timeoutSeconds) {
    issues.push(issue("benchmarkPolicy.timeout.mismatch", `Benchmark timeout must be ${policy.resources.timeoutSeconds} seconds.`));
  }
  if (actual.cpuCores !== policy.resources.cpuCores) {
    issues.push(issue("benchmarkPolicy.cpu.mismatch", `Benchmark CPU limit must be ${policy.resources.cpuCores}.`));
  }
  if (actual.memoryMb !== policy.resources.memoryMb) {
    issues.push(issue("benchmarkPolicy.memory.mismatch", `Benchmark memory limit must be ${policy.resources.memoryMb}MB.`));
  }
  if (actual.networkPolicy !== policy.resources.networkPolicy) {
    issues.push(issue("benchmarkPolicy.network.mismatch", "Benchmark network policy must remain blocked."));
  }
  return result(issues);
}
function policyForValidation(
  options: { benchmarkId?: string; submissionPolicy?: BenchmarkExecutionPolicy },
  issues: ValidationIssue[],
  prefix: string,
): BenchmarkExecutionPolicy {
  if (options.submissionPolicy) return options.submissionPolicy;
  if (options.benchmarkId) {
    const policy = benchmarkExecutionPolicyFor(options.benchmarkId);
    if (policy) return policy;
    issues.push(issue(`${prefix}.benchmarkPolicy.unknown`, "Benchmark execution policy is unknown."));
    return defaultBenchmarkExecutionPolicy();
  }
  issues.push(issue(`${prefix}.benchmarkPolicy.required`, "Benchmark execution policy is required before judging."));
  return defaultBenchmarkExecutionPolicy();
}

export interface BenchmarkExecutionRequestContext {
  benchmarkId: string;
  resources: unknown;
  trigger?: "pull_request" | "workflow_dispatch" | "manual";
  prHeadSha?: string;
  instanceId?: string;
  allowedInstanceIds?: readonly string[];
  maxWorkers?: number;
  artifactRetentionDays?: number;
  cacheKey?: string;
  harnessCommit?: string;
  datasetRevision?: string;
  harnessImageDigest?: string;
}

export function validateBenchmarkExecutionRequest(context: BenchmarkExecutionRequestContext): ValidationResult {
  const issues: ValidationIssue[] = [];
  const policy = benchmarkExecutionPolicyFor(context.benchmarkId);
  if (!policy) {
    issues.push(issue("benchmarkPolicy.unknown", "Benchmark must have an explicit execution policy before execution."));
    return result(issues);
  }
  issues.push(...validateBenchmarkResources(context.benchmarkId, context.resources).issues);

  if (policy.maintainerTriggeredOnly && context.trigger !== "workflow_dispatch" && context.trigger !== "manual") {
    issues.push(issue("benchmarkPolicy.trigger.maintainerRequired", "Benchmark execution must be maintainer-triggered."));
  }
  if (policy.explicitPrHeadShaRequired && !/^[0-9a-f]{40}$/i.test(context.prHeadSha ?? "")) {
    issues.push(issue("benchmarkPolicy.prHeadSha.required", "Benchmark execution requires an explicit PR head SHA."));
  }
  if (policy.allowlistedInstanceRequired) {
    if (!present(context.instanceId)) {
      issues.push(issue("benchmarkPolicy.instance.required", "Benchmark execution requires an explicit instance id."));
    } else if (!context.allowedInstanceIds?.includes(context.instanceId)) {
      issues.push(issue("benchmarkPolicy.instance.allowlist", "Benchmark instance id must be allowlisted."));
    }
  }
  if (policy.maxWorkers !== undefined && context.maxWorkers !== policy.maxWorkers) {
    issues.push(issue("benchmarkPolicy.maxWorkers.mismatch", `Benchmark max_workers must be ${policy.maxWorkers}.`));
  }
  if (policy.artifactRetentionDays !== undefined && context.artifactRetentionDays !== policy.artifactRetentionDays) {
    issues.push(issue("benchmarkPolicy.artifactRetention.mismatch", `Benchmark artifacts must retain for ${policy.artifactRetentionDays} days.`));
  }
  if (policy.cacheKeyComponents?.length) {
    const expectedCacheKey =
      present(context.harnessCommit) && present(context.datasetRevision) && dockerImageHasDigest(context.harnessImageDigest)
        ? swebenchDescriptorCacheKey({
            harnessCommit: context.harnessCommit!,
            datasetRevision: context.datasetRevision!,
            harnessImageDigest: context.harnessImageDigest!,
          })
        : null;
    if (!expectedCacheKey || context.cacheKey !== expectedCacheKey) {
      issues.push(issue("benchmarkPolicy.cacheKey.mismatch", "Benchmark cache key must bind harnessCommit, datasetRevision, and harnessImageDigest."));
    }
  }
  return result(issues);
}

const SUPPORTED_PR_SUBMISSION_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".go",
  ".java",
  ".js",
  ".json",
  ".md",
  ".py",
  ".rs",
  ".ts",
  ".txt",
  ".yaml",
  ".yml",
]);

const FORBIDDEN_PUBLIC_FIELD_NAMES = new Set([
  "patch",
  "patchtext",
  "rawpatch",
  "diff",
  "rawdiff",
  "stdout",
  "stdouttext",
  "stdoutref",
  "stderr",
  "stderrtext",
  "stderrref",
  "runnerlog",
  "runnerlogs",
  "fullrunnerlog",
  "log",
  "logs",
  "output",
  "runneroutput",
  "worktreepath",
  "temppath",
  "tmppath",
  "dbpath",
  "databasepath",
  "databaseurl",
  "rawreasoning",
  "reasoning",
  "reasoningtrace",
  "rawchainofthought",
  "chainofthought",
  "environment",
  "env",
  "secrets",
  "secret",
  "token",
  "fullbundle",
  "bundle",
  "resultbundle",
  "resultbundlepath",
  "rawresultbundle",
  "case",
  "cases",
  "testcase",
  "testcases",
  "hiddencase",
  "hiddencases",
  "oracle",
  "oraclepath",
  "oraclefilepath",
  "oracledir",
  "oracledirectory",
  "oracledescriptor",
  "oracledescriptorhash",
  "tokenbundle",
  "tokens",
  "inputtokens",
  "outputtokens",
  "apitoken",
  "apiorigin",
  "containerid",
  "containername",
  "containerpath",
  "containerbundle",
]);

const PR_SUBMISSION_ENVELOPE_KEYS = new Set([
  "schemaVersion",
  "id",
  "problemId",
  "adapterId",
  "prHeadSha",
  "patchSha256",
  "patchBytes",
  "patchStats",
  "files",
  "publicSubmission",
]);

const PR_SUBMISSION_FILE_KEYS = new Set(["path", "changeType", "gitMode", "byteSize", "isBinary", "isSymlink"]);
const PATCH_STATS_KEYS = new Set(["filesChanged", "locAdded", "locDeleted"]);
const PRIVATE_ORACLE_EVIDENCE_KEYS = new Set(["originalEvidenceId", "rerunEvidenceId"]);
const PRIVATE_ORACLE_BUNDLE_KEYS = new Set(["schemaVersion", "descriptors", "problems"]);
const PRIVATE_ORACLE_BASE_KEYS = new Set([
  "schemaVersion",
  "problemId",
  "benchmarkId",
  "adapterId",
  "upstreamTaskId",
  "oracleKind",
  "evidencePolicy",
  "descriptorRevision",
]);
const PYTHON_FUNCTION_DESCRIPTOR_KEYS = new Set([...PRIVATE_ORACLE_BASE_KEYS, "entryPoint", "cases"]);
const PYTHON_FUNCTION_TESTS_DESCRIPTOR_KEYS = new Set([...PRIVATE_ORACLE_BASE_KEYS, "entryPoint", "testSource", "testSourceHash"]);
const PYTHON_FUNCTION_CASE_KEYS = new Set(["id", "args", "expected"]);
const COMMAND_DESCRIPTOR_KEYS = new Set([
  ...PRIVATE_ORACLE_BASE_KEYS,
  "commandId",
  "allowedTargets",
  "hiddenTestBundleHash",
  "expectedExitCode",
  "testSource",
  "testSourceHash",
  "fixtureRef",
  "fixtureHash",
]);
const SWEBENCH_DESCRIPTOR_KEYS = new Set([
  ...PRIVATE_ORACLE_BASE_KEYS,
  "datasetName",
  "datasetRevision",
  "split",
  "instanceId",
  "repo",
  "baseCommit",
  "harnessCommit",
  "harnessImageDigest",
  "predictionJsonlSchemaHash",
  "cacheKey",
]);
const PRIVATE_ORACLE_KINDS = new Set<PrivateOracleDescriptorKind>([
  "python-function-cases",
  "python-function-tests",
  "command-hidden-tests",
  "swebench-upstream-harness",
]);
const SANITIZED_JUDGE_SUMMARY_KEYS = new Set([
  "schemaVersion",
  "submissionId",
  "problemId",
  "adapterId",
  "prHeadSha",
  "status",
  "passFail",
  "runtimeMs",
  "patchStats",
  "validationMessages",
  "resultHash",
]);

const FORBIDDEN_PUBLIC_TEXT_PATTERNS: readonly RegExp[] = [
  /\b(?:raw\s*)?chain[-_\s]?of[-_\s]?thought\b/i,
  /\bcot\b/i,
  /\bhidden reasoning\b/i,
  /\braw[-_\s]?reasoning\b/i,
  /\breasoning[-_\s]?trace\b/i,
  /\b(?:stdout|stderr)\b/i,
  /diff --git/i,
  /^index [0-9a-f]+\.\.[0-9a-f]+(?: [0-9]{6})?$/im,
  /^@@\s/m,
  /^(?:---|\+\+\+)\s/m,
  /^\s*[+-]\s*(?:return\b|assert\b|def\b|leaked_line|removed_line)/m,
  /^[+-].+$/m,
  /SHOULD_NOT_LEAK_PATCH/i,
  /\breturn\s+(?:xs\[0\]|missing|text\[::-1\])\b/i,
  /\bRan \d+ tests?\b/i,
  /^OK$/m,
  /Traceback \(most recent call last\):/i,
  /\bAssertionError\b/i,
  /(?:^|\s)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/m,
  /\b[A-Za-z0-9._-]+\.sqlite\b/i,
  /\bdatabase[_-\s]?url\s*(?:=|:)\s*\S+/i,
  /\b(?:secret|token|api[_-\s]?key|access[_-\s]?token|refresh[_-\s]?token)\s*(?:=|:)\s*\S+/i,
  /\bauthorization\s*:\s*bearer\s+\S+/i,
  /\bAGENTOJ_[A-Z0-9_]*(?:SECRET|TOKEN)[A-Z0-9_]*\s*=\s*\S+/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  /\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@[^/\s]+/i,
  /\b(?:oracle(?:[-_\s]?(?:path|file|dir|directory|descriptor))?|hidden[-_\s]?case|test[-_\s]?case|result[-_\s]?bundle|api[-_\s]?origin|container[-_\s]?(?:id|name|path))\s*(?:=|:)\s*\S+/i,
  /\bdef\s+test_[A-Za-z0-9_]*\s*\(/i,
  /\bfrom\s+python_programs\.[A-Za-z0-9_]+\s+import\b/i,
  /\bassert\s+[A-Za-z_][\w.]*\([^)]*\)\s*==/i,
  /\bhidden[-_\s]?(?:test|tests|pytest|descriptor|bundle|source)\b/i,
  /\b(?:\/[A-Za-z0-9._-]+)+(?:\/(?:oracle|hidden|cases?|result[-_]?bundle|container)[A-Za-z0-9._-]*)+\b/i,
  /(?:s&#(?:101|x65);cret|t&#(?:111|x6f);ken)\s*(?:=|:|&equals;)\s*\S+/i,
];

const ALLOWED_JUDGE_STATUSES = new Set(["passed", "failed", "timed-out", "infra-error", "invalid"]);
const ALLOWED_NORMAL_GIT_MODES = new Set(["100644", "100755"]);

function result(issues: ValidationIssue[]): ValidationResult {
  return { ok: issues.length === 0, issues };
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function dockerImageHasDigest(value: string | undefined): boolean {
  return present(value) && /@sha256:[0-9a-f]{64}$/i.test(value);
}

export function swebenchDescriptorCacheKey(input: {
  harnessCommit: string;
  datasetRevision: string;
  harnessImageDigest: string;
}): string {
  return `swebench:${input.harnessCommit}:${input.datasetRevision}:${input.harnessImageDigest}`;
}

function collectRequiredString(value: Record<string, unknown>, key: string, prefix: string, issues: ValidationIssue[]): void {
  if (!present(value[key] as string | undefined)) {
    issues.push(issue(`${prefix}.${key}.required`, `${key} is required.`));
  }
}

function validatePrivateOracleEvidencePolicy(value: unknown, prefix: string, issues: ValidationIssue[]): void {
  if (!isPlainRecord(value)) {
    issues.push(issue(`${prefix}.evidencePolicy.required`, "Private oracle evidence policy is required."));
    return;
  }
  collectUnknownKeys(value, PRIVATE_ORACLE_EVIDENCE_KEYS, `${prefix}.evidencePolicy`, issues);
  const original = value.originalEvidenceId as string | undefined;
  const rerun = value.rerunEvidenceId as string | undefined;
  if (!present(original)) issues.push(issue(`${prefix}.evidencePolicy.original.required`, "Original evidence id is required."));
  if (!present(rerun)) issues.push(issue(`${prefix}.evidencePolicy.rerun.required`, "Rerun evidence id is required."));
  if (present(original) && original === rerun) {
    issues.push(issue(`${prefix}.evidencePolicy.rerunDistinct`, "Original and rerun evidence ids must be distinct."));
  }
}

function validatePythonFunctionCases(value: unknown, prefix: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(issue(`${prefix}.cases.required`, "Python function descriptors require non-empty cases."));
    return;
  }
  value.forEach((entry, index) => {
    const casePrefix = `${prefix}.cases[${index}]`;
    if (!isPlainRecord(entry)) {
      issues.push(issue(`${casePrefix}.malformed`, "Python function case must be an object."));
      return;
    }
    collectUnknownKeys(entry, PYTHON_FUNCTION_CASE_KEYS, casePrefix, issues);
    if (!present(entry.id as string | undefined)) issues.push(issue(`${casePrefix}.id.required`, "Case id is required."));
    if (!Array.isArray(entry.args)) issues.push(issue(`${casePrefix}.args.required`, "Case args must be an array."));
    if (!hasOwn(entry, "expected")) issues.push(issue(`${casePrefix}.expected.required`, "Case expected value is required."));
  });
}

export function validatePrivateOracleDescriptor(
  input: unknown,
  expected: { problemId?: string; benchmarkId?: string; adapterId?: string; upstreamTaskId?: string } = {},
): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!isPlainRecord(input)) {
    issues.push(issue("privateOracleDescriptor.malformed", "Private oracle descriptor must be an object."));
    return result(issues);
  }

  const descriptor = input as Record<string, unknown>;
  const kind = descriptor.oracleKind as PrivateOracleDescriptorKind | undefined;
  const prefix = "privateOracleDescriptor";
  if (descriptor.schemaVersion !== 2) {
    issues.push(issue("privateOracleDescriptor.schemaVersion.unsupported", "Private oracle descriptor schemaVersion must be 2."));
  }
  if (!kind || !PRIVATE_ORACLE_KINDS.has(kind)) {
    issues.push(issue("privateOracleDescriptor.oracleKind.invalid", "Private oracle descriptor oracleKind is not supported."));
  }

  const allowedKeys =
    kind === "python-function-cases"
      ? PYTHON_FUNCTION_DESCRIPTOR_KEYS
      : kind === "python-function-tests"
        ? PYTHON_FUNCTION_TESTS_DESCRIPTOR_KEYS
        : kind === "command-hidden-tests"
          ? COMMAND_DESCRIPTOR_KEYS
          : kind === "swebench-upstream-harness"
            ? SWEBENCH_DESCRIPTOR_KEYS
            : PRIVATE_ORACLE_BASE_KEYS;
  collectUnknownKeys(descriptor, allowedKeys, prefix, issues);

  for (const key of ["problemId", "benchmarkId", "adapterId", "upstreamTaskId"] as const) {
    collectRequiredString(descriptor, key, prefix, issues);
    if (expected[key] && descriptor[key] !== expected[key]) {
      issues.push(issue(`privateOracleDescriptor.${key}.mismatch`, `Descriptor ${key} does not match the expected target.`));
    }
  }
  validatePrivateOracleEvidencePolicy(descriptor.evidencePolicy, prefix, issues);

  if (kind === "python-function-cases") {
    collectRequiredString(descriptor, "entryPoint", prefix, issues);
    validatePythonFunctionCases(descriptor.cases, prefix, issues);
  } else if (kind === "python-function-tests") {
    collectRequiredString(descriptor, "entryPoint", prefix, issues);
    collectRequiredString(descriptor, "testSource", prefix, issues);
    if (!isSha256Ref(descriptor.testSourceHash as string | undefined)) {
      issues.push(issue("privateOracleDescriptor.testSourceHash.invalid", "Python function test source hash must be sha256:<64 hex>."));
    } else if (present(descriptor.testSource as string | undefined) && descriptor.testSourceHash !== sha256Ref(descriptor.testSource as string)) {
      issues.push(issue("privateOracleDescriptor.testSourceHash.mismatch", "Python function test source hash must match testSource."));
    }
  } else if (kind === "command-hidden-tests") {
    collectRequiredString(descriptor, "commandId", prefix, issues);
    if (!nonEmptyStringArray(descriptor.allowedTargets)) {
      issues.push(issue("privateOracleDescriptor.allowedTargets.required", "Command hidden-test descriptors require non-empty allowedTargets."));
    } else {
      for (const [index, target] of (descriptor.allowedTargets as string[]).entries()) {
        if (!isSafeRelativeSubmissionPath(target)) {
          issues.push(issue(`privateOracleDescriptor.allowedTargets[${index}].invalid`, "Command hidden-test allowedTargets must be safe relative paths."));
        }
      }
    }
    if (!isSha256Ref(descriptor.hiddenTestBundleHash as string | undefined)) {
      issues.push(issue("privateOracleDescriptor.hiddenTestBundleHash.invalid", "Hidden test bundle hash must be sha256:<64 hex>."));
    }
    if (!nonNegativeInteger(descriptor.expectedExitCode as number)) {
      issues.push(issue("privateOracleDescriptor.expectedExitCode.invalid", "Expected exit code must be a non-negative integer."));
    }
    if (descriptor.commandId === "pytest-hidden" && descriptor.expectedExitCode !== 0) {
      issues.push(issue("privateOracleDescriptor.expectedExitCode.unsupported", "pytest-hidden descriptors must expect exit code 0."));
    }
    collectRequiredString(descriptor, "testSource", prefix, issues);
    if (!isSha256Ref(descriptor.testSourceHash as string | undefined)) {
      issues.push(issue("privateOracleDescriptor.testSourceHash.invalid", "Command hidden-test source hash must be sha256:<64 hex>."));
    } else if (present(descriptor.testSource as string | undefined) && descriptor.testSourceHash !== sha256Ref(descriptor.testSource as string)) {
      issues.push(issue("privateOracleDescriptor.testSourceHash.mismatch", "Command hidden-test source hash must match testSource."));
    }
    if (
      isSha256Ref(descriptor.hiddenTestBundleHash as string | undefined) &&
      isSha256Ref(descriptor.testSourceHash as string | undefined) &&
      descriptor.hiddenTestBundleHash !== descriptor.testSourceHash
    ) {
      issues.push(issue("privateOracleDescriptor.hiddenTestBundleHash.mismatch", "Hidden test bundle hash must match testSourceHash."));
    }
  } else if (kind === "swebench-upstream-harness") {
    for (const key of [
      "datasetName",
      "datasetRevision",
      "split",
      "instanceId",
      "repo",
      "baseCommit",
      "harnessCommit",
      "cacheKey",
    ] as const) {
      collectRequiredString(descriptor, key, prefix, issues);
    }
    if (!dockerImageHasDigest(descriptor.harnessImageDigest as string | undefined)) {
      issues.push(issue("privateOracleDescriptor.harnessImageDigest.invalid", "SWE-bench harness image must be pinned as image@sha256:<64 hex>."));
    }
    if (!isSha256Ref(descriptor.predictionJsonlSchemaHash as string | undefined)) {
      issues.push(issue("privateOracleDescriptor.predictionJsonlSchemaHash.invalid", "Prediction JSONL schema hash must be sha256:<64 hex>."));
    }
    const cacheKeyInput = {
      harnessCommit: descriptor.harnessCommit as string | undefined,
      datasetRevision: descriptor.datasetRevision as string | undefined,
      harnessImageDigest: descriptor.harnessImageDigest as string | undefined,
    };
    if (
      present(cacheKeyInput.harnessCommit) &&
      present(cacheKeyInput.datasetRevision) &&
      dockerImageHasDigest(cacheKeyInput.harnessImageDigest) &&
      descriptor.cacheKey !== swebenchDescriptorCacheKey(cacheKeyInput as { harnessCommit: string; datasetRevision: string; harnessImageDigest: string })
    ) {
      issues.push(issue("privateOracleDescriptor.cacheKey.mismatch", "SWE-bench cacheKey must bind harnessCommit, datasetRevision, and harnessImageDigest."));
    }
  }

  return result(issues);
}


function sha256Ref(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalEvidencePolicy(descriptor: PrivateOracleDescriptor) {
  return {
    originalEvidenceId: descriptor.evidencePolicy.originalEvidenceId,
    rerunEvidenceId: descriptor.evidencePolicy.rerunEvidenceId,
  };
}

function canonicalPrivateOracleDescriptor(descriptor: PrivateOracleDescriptor): PrivateOracleDescriptor {
  const common = {
    schemaVersion: descriptor.schemaVersion,
    problemId: descriptor.problemId,
    benchmarkId: descriptor.benchmarkId,
    adapterId: descriptor.adapterId,
    upstreamTaskId: descriptor.upstreamTaskId,
    oracleKind: descriptor.oracleKind,
  };

  if (descriptor.oracleKind === "python-function-cases") {
    return {
      ...common,
      oracleKind: descriptor.oracleKind,
      entryPoint: descriptor.entryPoint,
      cases: descriptor.cases.map((entry) => ({ id: entry.id, args: entry.args, expected: entry.expected })),
      evidencePolicy: canonicalEvidencePolicy(descriptor),
      ...(descriptor.descriptorRevision ? { descriptorRevision: descriptor.descriptorRevision } : {}),
    };
  }
  if (descriptor.oracleKind === "python-function-tests") {
    return {
      ...common,
      oracleKind: descriptor.oracleKind,
      entryPoint: descriptor.entryPoint,
      testSource: descriptor.testSource,
      testSourceHash: descriptor.testSourceHash,
      evidencePolicy: canonicalEvidencePolicy(descriptor),
      ...(descriptor.descriptorRevision ? { descriptorRevision: descriptor.descriptorRevision } : {}),
    };
  }
  if (descriptor.oracleKind === "command-hidden-tests") {
    return {
      ...common,
      oracleKind: descriptor.oracleKind,
      commandId: descriptor.commandId,
      allowedTargets: descriptor.allowedTargets,
      hiddenTestBundleHash: descriptor.hiddenTestBundleHash,
      expectedExitCode: descriptor.expectedExitCode,
      testSource: descriptor.testSource,
      testSourceHash: descriptor.testSourceHash,
      evidencePolicy: canonicalEvidencePolicy(descriptor),
      ...(descriptor.descriptorRevision ? { descriptorRevision: descriptor.descriptorRevision } : {}),
      ...(descriptor.fixtureRef ? { fixtureRef: descriptor.fixtureRef } : {}),
      ...(descriptor.fixtureHash ? { fixtureHash: descriptor.fixtureHash } : {}),
    };
  }
  return {
    ...common,
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
    evidencePolicy: canonicalEvidencePolicy(descriptor),
    ...(descriptor.descriptorRevision ? { descriptorRevision: descriptor.descriptorRevision } : {}),
  };
}
function versionedCanonicalPrivateOracleDescriptor(
  target: { problemId: string; benchmarkId?: string; adapterId?: string; upstreamTaskId?: string; expectedOracleDescriptorHash?: string },
  value: unknown,
): { canonicalJson: string; descriptor: PrivateOracleDescriptor } | null {
  const validation = validatePrivateOracleDescriptor(value, target);
  if (!validation.ok) return null;
  const descriptor = value as PrivateOracleDescriptor;
  const canonicalJson = JSON.stringify(canonicalPrivateOracleDescriptor(descriptor));
  if (target.expectedOracleDescriptorHash && sha256Ref(canonicalJson) !== target.expectedOracleDescriptorHash) return null;
  return { canonicalJson, descriptor };
}

export function selectCanonicalPrivateOracleDescriptor(
  target: { problemId: string; benchmarkId?: string; adapterId?: string; upstreamTaskId?: string; expectedOracleDescriptorHash?: string },
  parsed: unknown,
): { canonicalJson: string; descriptor: PrivateOracleDescriptor } | null {
  const directVersioned = versionedCanonicalPrivateOracleDescriptor(target, parsed);
  if (directVersioned) return directVersioned;

  if (!isPlainRecord(parsed) || parsed.schemaVersion !== 2) return null;
  const bundleIssues: ValidationIssue[] = [];
  collectUnknownKeys(parsed, PRIVATE_ORACLE_BUNDLE_KEYS, "privateOracleBundle", bundleIssues);
  if (bundleIssues.length > 0) return null;

  const bundle = parsed as { descriptors?: unknown; problems?: unknown };
  if (Array.isArray(bundle.descriptors)) {
    for (const entry of bundle.descriptors) {
      const selected = versionedCanonicalPrivateOracleDescriptor(target, entry);
      if (selected) return selected;
    }
  }
  if (isPlainRecord(bundle.problems)) {
    const selected = bundle.problems[target.problemId];
    if (selected !== undefined) return versionedCanonicalPrivateOracleDescriptor(target, selected);
  }
  return null;
}

function issue(code: string, message: string): ValidationIssue {
  return { code, message };
}

function present(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
function isSha256Ref(value: string | undefined): boolean {
  return /^sha256:[0-9a-f]{64}$/i.test(value ?? "");
}

function positiveNumber(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function hasCommand(command: readonly string[]): boolean {
  return command.length > 0 && command.every((part) => present(part));
}

function nonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => present(entry));
}

function hasRequiredSet<T extends string>(actual: readonly T[], required: readonly T[]): boolean {
  return required.every((key) => actual.includes(key));
}

function isPublicRecordingLink(value: string | undefined): boolean {
  if (!present(value)) return false;
  if (/^\/recordings\/[A-Za-z0-9._-]+$/.test(value)) return true;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      /^\/recordings\/[A-Za-z0-9._-]+$/.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

function nonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function boundedPositiveInteger(value: number, max: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= max;
}

function lowerExtension(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  const basename = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const dot = basename.lastIndexOf(".");
  return dot >= 0 ? basename.slice(dot).toLowerCase() : "";
}

function isSafeRelativeSubmissionPath(path: string): boolean {
  if (!present(path)) return false;
  if (path.startsWith("/") || path.startsWith("\\") || path.includes("\\")) return false;
  return path.split("/").every((part) => present(part) && part !== "." && part !== "..");
}

function normalizedFieldName(key: string): string {
  return key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function collectUnknownKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  prefix: string,
  issues: ValidationIssue[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      issues.push(issue(`${prefix}.key.unknown`, `Unknown key '${key}' is not allowed at ${prefix}.`));
    }
  }
}


function collectForbiddenPublicPayloadIssues(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  seen: WeakSet<object> = new WeakSet<object>(),
  depth = 0,
): void {
  if (depth > 32) {
    issues.push(issue("publicPayload.depth.forbidden", `Public payload is too deeply nested at ${path}.`));
    return;
  }
  if (typeof value === "string") {
    for (const pattern of FORBIDDEN_PUBLIC_TEXT_PATTERNS) {
      if (pattern.test(value)) {
        issues.push(issue("publicPayload.text.forbidden", `Forbidden public text at ${path}.`));
        break;
      }
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) {
    issues.push(issue("publicPayload.cycle.forbidden", `Public payload cannot contain circular references at ${path}.`));
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectForbiddenPublicPayloadIssues(entry, `${path}[${index}]`, issues, seen, depth + 1));
    return;
  }
  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = normalizedFieldName(key);
    if (FORBIDDEN_PUBLIC_FIELD_NAMES.has(normalizedKey)) {
      issues.push(issue("publicPayload.key.forbidden", `Forbidden public field '${key}' at ${path}.`));
      continue;
    }
    collectForbiddenPublicPayloadIssues(nestedValue, `${path}.${key}`, issues, seen, depth + 1);
  }
}

function validatePatchStats(
  stats: PrSubmissionEnvelope["patchStats"] | SanitizedPrJudgeSummary["patchStats"] | undefined,
  issues: ValidationIssue[],
  prefix: string,
  maxFiles = MAX_PR_PATCH_FILES,
): void {
  if (!stats || typeof stats !== "object") {
    issues.push(issue(`${prefix}.patchStats.required`, "Patch stats are required."));
    return;
  }
  collectUnknownKeys(stats as Record<string, unknown>, PATCH_STATS_KEYS, `${prefix}.patchStats`, issues);
  if (!boundedPositiveInteger(stats.filesChanged, maxFiles)) {
    issues.push(issue(`${prefix}.filesChanged.bounds`, `Patch may touch 1-${maxFiles} files.`));
  }
  if (!nonNegativeInteger(stats.locAdded)) {
    issues.push(issue(`${prefix}.locAdded.nonNegative`, "Patch additions must be a non-negative integer."));
  }
  if (!nonNegativeInteger(stats.locDeleted)) {
    issues.push(issue(`${prefix}.locDeleted.nonNegative`, "Patch deletions must be a non-negative integer."));
  }
}

export function parsePublicMetricsJson(jsonText: string): PublicMetrics {
  const value = JSON.parse(jsonText) as Record<string, unknown>;
  if (value.passFail !== "pass" && value.passFail !== "fail") {
    throw new Error("Invalid public metric: passFail");
  }
  if (typeof value.runtimeMs !== "number" || !Number.isFinite(value.runtimeMs) || value.runtimeMs <= 0) {
    throw new Error("Invalid public metric: runtimeMs");
  }
  if (typeof value.filesChanged !== "number" || !Number.isFinite(value.filesChanged) || value.filesChanged < 0) {
    throw new Error("Invalid public metric: filesChanged");
  }
  if (typeof value.locAdded !== "number" || !Number.isFinite(value.locAdded) || value.locAdded < 0) {
    throw new Error("Invalid public metric: locAdded");
  }
  if (typeof value.locDeleted !== "number" || !Number.isFinite(value.locDeleted) || value.locDeleted < 0) {
    throw new Error("Invalid public metric: locDeleted");
  }
  return {
    passFail: value.passFail,
    runtimeMs: value.runtimeMs,
    filesChanged: value.filesChanged,
    locAdded: value.locAdded,
    locDeleted: value.locDeleted,
  };
}

export function publicMetricsMatchPatchStats(metrics: PublicMetrics, patchStats: PatchSubmission["patchStats"]): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (metrics.filesChanged !== patchStats.filesChanged) {
    issues.push(issue("leaderboard.metrics.filesChangedMismatch", "Public file count must match canonical submission patch stats."));
  }
  if (metrics.locAdded !== patchStats.locAdded) {
    issues.push(issue("leaderboard.metrics.locAddedMismatch", "Public added LOC must match canonical submission patch stats."));
  }
  if (metrics.locDeleted !== patchStats.locDeleted) {
    issues.push(issue("leaderboard.metrics.locDeletedMismatch", "Public deleted LOC must match canonical submission patch stats."));
  }
  return result(issues);
}

export function validatePrSubmissionEnvelope(
  input: unknown,
  options: {
    enabledProblemIds?: readonly string[];
    enabledAdapterIds?: readonly string[];
    requirePrHeadSha?: boolean;
    benchmarkId?: string;
    submissionPolicy?: BenchmarkExecutionPolicy;
  } = {},
): ValidationResult {
  const issues: ValidationIssue[] = [];
  collectForbiddenPublicPayloadIssues(input, "submission", issues);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    issues.push(issue("prSubmission.malformed", "PR submission envelope must be an object."));
    return result(issues);
  }
  const envelope = input as PrSubmissionEnvelope;
  const submissionPolicy = policyForValidation(options, issues, "prSubmission");
  collectUnknownKeys(input as Record<string, unknown>, PR_SUBMISSION_ENVELOPE_KEYS, "prSubmission", issues);

  if (envelope.schemaVersion !== PR_SUBMISSION_SCHEMA_VERSION) {
    issues.push(issue("prSubmission.schemaVersion.unsupported", "PR submission envelope schema version must be 1."));
  }
  if (!present(envelope.id)) issues.push(issue("prSubmission.id.required", "Submission id is required."));
  if (!present(envelope.problemId)) issues.push(issue("prSubmission.problem.required", "Problem id is required."));
  if (!present(envelope.adapterId)) issues.push(issue("prSubmission.adapter.required", "Adapter id is required."));
  if (!options.enabledProblemIds) {
    issues.push(issue("prSubmission.problemAllowlist.required", "Enabled problem allowlist is required for PR judging."));
  } else if (!options.enabledProblemIds.includes(envelope.problemId)) {
    issues.push(issue("prSubmission.problem.disabled", "Problem must be enabled for PR judging."));
  }
  if (!options.enabledAdapterIds) {
    issues.push(issue("prSubmission.adapterAllowlist.required", "Enabled adapter allowlist is required for PR judging."));
  } else if (!options.enabledAdapterIds.includes(envelope.adapterId)) {
    issues.push(issue("prSubmission.adapter.disabled", "Adapter must be enabled for PR judging."));
  }
  if (options.requirePrHeadSha !== false || present(envelope.prHeadSha)) {
    if (!/^[0-9a-f]{7,40}$/i.test(envelope.prHeadSha ?? "")) {
      issues.push(issue("prSubmission.prHeadSha.invalid", "PR head SHA must identify the judged commit when provided."));
    }
  }
  if (!/^sha256:[0-9a-f]{64}$/i.test(envelope.patchSha256 ?? "")) {
    issues.push(issue("prSubmission.patchSha256.invalid", "Patch SHA-256 must be recorded as sha256:<64 hex>."));
  }
  if (!boundedPositiveInteger(envelope.patchBytes, submissionPolicy.maxPatchBytes)) {
    issues.push(issue("prSubmission.patchBytes.bounds", `Patch must be 1-${submissionPolicy.maxPatchBytes} bytes.`));
  }
  validatePatchStats(envelope.patchStats, issues, "prSubmission", submissionPolicy.maxPatchFiles);

  if (!Array.isArray(envelope.files) || envelope.files.length === 0) {
    issues.push(issue("prSubmission.files.required", "At least one changed file is required."));
  } else if (envelope.files.length > submissionPolicy.maxPatchFiles) {
    issues.push(issue("prSubmission.files.tooMany", `PR submission may touch at most ${submissionPolicy.maxPatchFiles} files.`));
  } else if (envelope.patchStats?.filesChanged !== envelope.files.length) {
    issues.push(issue("prSubmission.files.statsMismatch", "Changed file count must match patch stats."));
  }

  for (const file of envelope.files ?? []) {
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      issues.push(issue("prSubmission.file.malformed", "Changed file entries must be objects."));
      continue;
    }
    collectUnknownKeys(file as Record<string, unknown>, PR_SUBMISSION_FILE_KEYS, "prSubmission.file", issues);
    if (!isSafeRelativeSubmissionPath(file.path)) {
      issues.push(issue("prSubmission.file.pathUnsafe", "Changed file paths must stay inside the submission worktree."));
      continue;
    }
    if (!SUPPORTED_PR_SUBMISSION_EXTENSIONS.has(lowerExtension(file.path))) {
      issues.push(issue("prSubmission.file.extensionUnsupported", `Unsupported submission file extension for '${file.path}'.`));
    }
    if (file.changeType !== "add" && file.changeType !== "modify" && file.changeType !== "delete") {
      issues.push(issue("prSubmission.file.changeType", "Changed files must declare add, modify, or delete."));
    }
    if (!ALLOWED_NORMAL_GIT_MODES.has(file.gitMode)) {
      issues.push(issue("prSubmission.file.modeUnsafe", "Changed files must use a normal file git mode."));
    }
    if (!boundedPositiveInteger(file.byteSize, submissionPolicy.maxFileBytes)) {
      issues.push(issue("prSubmission.file.byteSize.bounds", `Changed files must be 1-${submissionPolicy.maxFileBytes} bytes.`));
    }
    if (file.isBinary !== false) {
      issues.push(issue("prSubmission.file.binary.forbidden", "Binary patches are forbidden for PR judging."));
    }
    if (file.isSymlink !== false || file.gitMode === "120000") {
      issues.push(issue("prSubmission.file.symlink.forbidden", "Symlink patches are forbidden for PR judging."));
    }
  }

  if (envelope.publicSubmission !== true) {
    issues.push(issue("prSubmission.public.required", "PR submissions are public by design and must declare publicSubmission true."));
  }

  return result(issues);
}

export function validateSanitizedPrJudgeSummary(
  input: unknown,
  options: { enabledProblemIds?: readonly string[]; enabledAdapterIds?: readonly string[]; benchmarkId?: string; submissionPolicy?: BenchmarkExecutionPolicy } = {},
): ValidationResult {
  const issues: ValidationIssue[] = [];
  collectForbiddenPublicPayloadIssues(input, "summary", issues);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    issues.push(issue("prJudgeSummary.malformed", "Judge summary must be an object."));
    return result(issues);
  }
  const summary = input as SanitizedPrJudgeSummary;
  const summaryPolicy =
    summary.status === "invalid"
      ? defaultBenchmarkExecutionPolicy()
      : policyForValidation(options, issues, "prJudgeSummary");
  collectUnknownKeys(input as Record<string, unknown>, SANITIZED_JUDGE_SUMMARY_KEYS, "prJudgeSummary", issues);


  let encoded = "";
  try {
    encoded = JSON.stringify(summary);
  } catch {
    issues.push(issue("prJudgeSummary.stringify.failed", "Judge summary must be JSON serializable."));
  }
  if (encoded && Buffer.byteLength(encoded, "utf8") > MAX_SANITIZED_JUDGE_SUMMARY_BYTES) {
    issues.push(issue("prJudgeSummary.size.bounds", `Sanitized judge summary must be ${MAX_SANITIZED_JUDGE_SUMMARY_BYTES} bytes or smaller.`));
  }
  if (summary.schemaVersion !== PR_SUBMISSION_SCHEMA_VERSION) {
    issues.push(issue("prJudgeSummary.schemaVersion.unsupported", "Judge summary schema version must be 1."));
  }
  if (!present(summary.submissionId)) issues.push(issue("prJudgeSummary.submission.required", "Submission id is required."));
  if (!present(summary.problemId)) issues.push(issue("prJudgeSummary.problem.required", "Problem id is required."));
  if (!present(summary.adapterId)) issues.push(issue("prJudgeSummary.adapter.required", "Adapter id is required."));
  if (summary.status !== "invalid") {
    if (!options.enabledProblemIds) {
      issues.push(issue("prJudgeSummary.problemAllowlist.required", "Enabled problem allowlist is required for judge summaries."));
    } else if (!options.enabledProblemIds.includes(summary.problemId)) {
      issues.push(issue("prJudgeSummary.problem.disabled", "Problem must be enabled for PR judging."));
    }
    if (!options.enabledAdapterIds) {
      issues.push(issue("prJudgeSummary.adapterAllowlist.required", "Enabled adapter allowlist is required for judge summaries."));
    } else if (!options.enabledAdapterIds.includes(summary.adapterId)) {
      issues.push(issue("prJudgeSummary.adapter.disabled", "Adapter must be enabled for PR judging."));
    }
  }
  if (!/^[0-9a-f]{7,40}$/i.test(summary.prHeadSha ?? "")) {
    issues.push(issue("prJudgeSummary.prHeadSha.invalid", "PR head SHA must identify the judged commit."));
  }
  if (!ALLOWED_JUDGE_STATUSES.has(summary.status)) {
    issues.push(issue("prJudgeSummary.status.invalid", "Judge status is not allowed."));
  }
  if (summary.passFail !== "pass" && summary.passFail !== "fail") {
    issues.push(issue("prJudgeSummary.passFail.invalid", "Judge summary passFail must be pass or fail."));
  }
  if (summary.status === "passed" && summary.passFail !== "pass") {
    issues.push(issue("prJudgeSummary.passFail.mismatch", "Passed status must carry pass public result."));
  }
  if (summary.status !== "passed" && summary.passFail !== "fail") {
    issues.push(issue("prJudgeSummary.passFail.mismatch", "Non-passing statuses must carry fail public result."));
  }
  if (!nonNegativeInteger(summary.runtimeMs)) {
    issues.push(issue("prJudgeSummary.runtime.bounds", "Runtime must be a non-negative integer in milliseconds."));
  }
  validatePatchStats(summary.patchStats, issues, "prJudgeSummary", summaryPolicy.maxPatchFiles);
  if (!Array.isArray(summary.validationMessages) || summary.validationMessages.length > 20) {
    issues.push(issue("prJudgeSummary.messages.bounds", "Judge summary may include at most 20 validation messages."));
  } else if (!summary.validationMessages.every((message) => present(message) && message.length <= 240)) {
    issues.push(issue("prJudgeSummary.messages.safe", "Validation messages must be non-empty and bounded."));
  }
  if (!/^sha256:[0-9a-f]{64}$/i.test(summary.resultHash ?? "")) {
    issues.push(issue("prJudgeSummary.resultHash.invalid", "Result hash must be recorded as sha256:<64 hex>."));
  }

  return result(issues);
}

export function validateBenchmark(benchmark: Benchmark): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!present(benchmark.id)) issues.push(issue("benchmark.id.required", "Benchmark id is required."));
  if (!present(benchmark.name)) issues.push(issue("benchmark.name.required", "Benchmark name is required."));
  if (!present(benchmark.upstreamUrl)) issues.push(issue("benchmark.upstream.required", "Upstream URL is required."));

  if (!present(benchmark.upstreamCommitOrVersion)) {
    issues.push(issue("benchmark.upstreamCommit.required", "Upstream commit or version must be pinned."));
  }
  if (!PERMISSIVE_LICENSES.has(benchmark.licenseId)) {
    issues.push(issue("benchmark.license.notPermissive", "Only permissive allowlisted licenses are eligible."));
  }
  if (benchmark.legalStatus === "unknown") {
    issues.push(issue("benchmark.legalStatus.unknown", "Unknown legal status blocks catalog inclusion."));
  }
  if (benchmark.legalStatus === "rejected") {
    issues.push(issue("benchmark.legalStatus.rejected", "Rejected legal status blocks catalog inclusion."));
  }
  if (benchmark.defaultHostingMode === "hosted" && benchmark.redistributionRights !== "clear") {
    issues.push(issue("benchmark.hosted.redistribution", "Hosted mode requires clear redistribution rights."));
  }

  return result(issues);
}

export function allowedProblemHostingModes(benchmark: Benchmark): HostingMode[] {
  if (benchmark.redistributionRights === "clear") return ["hosted", "adapter-only"];
  return ["adapter-only"];
}

export function validateAdapter(adapter: Adapter, benchmark: Benchmark): ValidationResult {
  const issues: ValidationIssue[] = [];
  const benchmarkResult = validateBenchmark(benchmark);
  issues.push(...benchmarkResult.issues);

  if (!present(adapter.id)) issues.push(issue("adapter.id.required", "Adapter id is required."));
  if (adapter.benchmarkId !== benchmark.id) {
    issues.push(issue("adapter.benchmark.mismatch", "Adapter benchmarkId must match the benchmark."));
  }
  if (!present(adapter.adapterVersion)) issues.push(issue("adapter.version.required", "Adapter version is required."));
  if (!hasCommand(adapter.judgeCommand)) issues.push(issue("adapter.judgeCommand.required", "Adapter needs a judge command descriptor."));
  if (adapter.verificationCommands.length === 0 || !adapter.verificationCommands.every(hasCommand)) {
    issues.push(issue("adapter.verification.required", "Adapter needs at least one verification command."));
  }
  if (
    !present(adapter.dockerImageDigest) ||
    !/^[a-z0-9][a-z0-9._/-]*(?::[a-zA-Z0-9._-]+)?@sha256:[a-f0-9]{64}$/.test(adapter.dockerImageDigest)
  ) {
    issues.push(issue("adapter.dockerDigest.required", "Adapter must pin a concrete Docker image name to a sha256 digest."));
  }
  if (!positiveNumber(adapter.defaultResources.timeoutSeconds)) {
    issues.push(issue("adapter.timeout.required", "Adapter timeout must be positive."));
  }
  if (!positiveNumber(adapter.defaultResources.cpuCores)) {
    issues.push(issue("adapter.cpu.required", "Adapter CPU limit must be positive."));
  }
  if (!positiveNumber(adapter.defaultResources.memoryMb)) {
    issues.push(issue("adapter.memory.required", "Adapter memory limit must be positive."));
  }
  if (adapter.defaultResources.networkPolicy !== "blocked") {
    issues.push(issue("adapter.network.blocked", "MVP adapters must default to blocked network."));
  }
  issues.push(...validateBenchmarkResources(adapter.benchmarkId, adapter.defaultResources).issues);
  if (adapter.supportedHostingModes.length === 0) {
    issues.push(issue("adapter.hostingModes.required", "Adapter must declare supported hosting modes."));
  }
  if (adapter.supportedHostingModes.includes("hosted") && benchmark.redistributionRights !== "clear") {
    issues.push(issue("adapter.hosted.redistribution", "Adapter cannot support hosted mode without clear benchmark redistribution rights."));
  }

  return result(issues);
}

export function validateProblem(problem: Problem, benchmark: Benchmark, adapter: Adapter): ValidationResult {
  const issues: ValidationIssue[] = [];
  issues.push(...validateAdapter(adapter, benchmark).issues);


  if (!present(problem.id)) {
    issues.push(issue("problem.id.required", "Problem id is required."));
  }
  if (!present(problem.title)) {
    issues.push(issue("problem.title.required", "Problem title is required."));
  }
  if (problem.languageFrameworkTags.length === 0 || !problem.languageFrameworkTags.every(present)) {
    issues.push(issue("problem.languageTags.required", "Problem needs at least one language/framework tag."));
  }
  if (problem.editableFilePaths.length === 0 || !problem.editableFilePaths.every(isSafeRelativeSubmissionPath)) {
    issues.push(issue("problem.editableFiles.required", "Problem must declare at least one safe editable file path."));
  }

  if (problem.benchmarkId !== benchmark.id) {
    issues.push(issue("problem.benchmark.mismatch", "Problem benchmarkId must match benchmark."));
  }
  if (problem.adapterId !== adapter.id) {
    issues.push(issue("problem.adapter.mismatch", "Problem adapterId must match adapter."));
  }
  if (!allowedProblemHostingModes(benchmark).includes(problem.hostingMode)) {
    issues.push(issue("problem.hostingMode.notAllowed", "Hosted problems require clear redistribution rights."));
  }
  if (!adapter.supportedHostingModes.includes(problem.hostingMode)) {
    issues.push(issue("problem.hostingMode.adapterUnsupported", "Adapter does not support the problem hosting mode."));
  }
  if (!present(problem.upstreamTaskId)) {
    issues.push(issue("problem.upstreamTask.required", "Problem must reference the upstream task id."));
  }
  if (problem.scoringMode !== undefined && problem.scoringMode !== "demo-public" && problem.scoringMode !== "scored-hidden") {
    issues.push(issue("problem.scoringMode.invalid", "Problem scoringMode must be demo-public or scored-hidden."));
  }
  if (problem.scoringMode !== "scored-hidden" && problem.oracleMetadata !== undefined) {
    issues.push(issue("problem.oracleMetadata.scoredOnly", "Only scored-hidden problems may carry oracle metadata."));
  }
  if (problem.scoringMode === "scored-hidden") {
    const oracle = problem.oracleMetadata;
    if (!oracle || typeof oracle !== "object") {
      issues.push(issue("problem.oracleMetadata.required", "Scored-hidden problems require hidden or generated private oracle metadata."));
    } else {
      if (oracle.kind !== "hidden-fixture" && oracle.kind !== "generated-private") {
        issues.push(issue("problem.oracleMetadata.kind", "Oracle metadata kind must be hidden-fixture or generated-private."));
      }
      if (oracle.hiddenRequired !== true) {
        issues.push(issue("problem.oracleMetadata.hiddenRequired", "Scored-hidden problems must require hidden oracle execution."));
      }
      if (!isSha256Ref(oracle.oracleDescriptorHash)) {
        issues.push(issue("problem.oracleMetadata.descriptorHash", "Oracle descriptor hash must be sha256:<64 hex>."));
      }
      if (
        present(oracle.originalEvidenceId) &&
        present(oracle.rerunEvidenceId) &&
        oracle.originalEvidenceId === oracle.rerunEvidenceId
      ) {
        issues.push(issue("problem.oracleMetadata.rerunDistinct", "Original and rerun evidence ids must be distinct when public metadata includes them."));
      }
    }
  }

  return result(issues);
}

export function isLeaderboardEligible(entry: LeaderboardEntry, runnerResult: RunnerResult): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!entry.reproducibleResult) {
    issues.push(issue("leaderboard.reproducible.required", "Leaderboard eligibility requires reproducible runner evidence."));
  }
  if (runnerResult.patchApplyStatus !== "clean") {
    issues.push(issue("leaderboard.patch.clean", "Leaderboard eligibility requires clean patch application."));
  }
  if (runnerResult.passFail !== "pass" || runnerResult.exitCode !== 0) {
    issues.push(issue("leaderboard.runner.pass", "Leaderboard eligibility requires a passing runner result."));
  }
  if (!positiveNumber(runnerResult.runtimeMs)) {
    issues.push(issue("leaderboard.runner.runtime", "Runner runtime must be positive."));
  }
  if (!present(runnerResult.resultHash) || !present(runnerResult.stdoutRef) || !present(runnerResult.stderrRef)) {
    issues.push(issue("leaderboard.runner.evidence", "Runner evidence refs and result hash are required."));
  }
  if (entry.publicMetrics.passFail !== runnerResult.passFail) {
    issues.push(issue("leaderboard.metrics.passFailMismatch", "Public pass/fail metric must match runner result."));
  }
  if (entry.publicMetrics.runtimeMs !== runnerResult.runtimeMs) {
    issues.push(issue("leaderboard.metrics.runtimeMismatch", "Public runtime metric must match runner result."));
  }
  if (!positiveNumber(entry.publicMetrics.runtimeMs)) {
    issues.push(issue("leaderboard.metrics.runtime", "Minimum public runtime metric is required."));
  }

  if (entry.publicMetrics.filesChanged < 0 || entry.publicMetrics.locAdded < 0 || entry.publicMetrics.locDeleted < 0) {
    issues.push(issue("leaderboard.metrics.nonNegative", "Patch metrics must be non-negative."));
  }

  return result(issues);
}

export function validateRecording(recording: SolutionRecording): ValidationResult {
  const issues: ValidationIssue[] = [];

  const requiredText: Array<[string, string]> = [
    ["recording.id.required", recording.id],
    ["recording.submission.required", recording.submissionId],
    ["recording.problem.required", recording.problemId],
    ["recording.benchmark.required", recording.benchmarkId],
    ["recording.upstream.required", recording.upstreamCommit],
    ["recording.dockerDigest.required", recording.dockerImageDigest],
    ["recording.patch.required", recording.finalPatchSha256],
    ["recording.summary.required", recording.summary],
    ["recording.rootCause.required", recording.rootCause],
    ["recording.fix.required", recording.fixDescription],
    ["recording.evidence.required", recording.evidenceLedgerId],
  ];

  for (const [code, value] of requiredText) {
    if (!present(value)) issues.push(issue(code, `${code} is missing.`));
  }
  if (recording.passFail !== "pass") {
    issues.push(issue("recording.passFail.pass", "Solution recordings must represent passing submissions."));
  }
  if (recording.locDelta.added < 0 || recording.locDelta.deleted < 0) {
    issues.push(issue("recording.locDelta.nonNegative", "Recording LOC delta must be non-negative."));
  }
  if (!positiveNumber(recording.resources.timeoutSeconds) || !positiveNumber(recording.resources.cpuCores) || !positiveNumber(recording.resources.memoryMb)) {
    issues.push(issue("recording.resources.positive", "Recording resource limits must be positive."));
  }
  if (recording.resources.networkPolicy !== "blocked") {
    issues.push(issue("recording.network.blocked", "MVP recordings must use blocked network policy."));
  }

  if (!recording.dockerImageDigest.includes("sha256:")) {
    issues.push(issue("recording.dockerDigest.pinned", "Recording must pin a Docker image digest."));
  }
  if (recording.verificationCommands.length === 0 || !recording.verificationCommands.every(hasCommand)) {
    issues.push(issue("recording.verification.required", "Recording needs verification commands."));
  }
  if (recording.scoringStatus === "scored" && !present(recording.oracleDescriptorHash)) {
    issues.push(issue("recording.oracle.required", "Scored recordings require an opaque oracle descriptor hash."));
  }
  if (!present(recording.originalJobId)) {
    issues.push(issue("recording.originalJob.required", "Original job id is required."));
  }
  if (!present(recording.originalResultId) || !present(recording.originalResultHash)) {
    issues.push(issue("recording.originalResult.required", "Original result id and hash are required."));
  }
  if (recording.scoringStatus !== "demo" && recording.scoringStatus !== "scored") {
    issues.push(issue("recording.scoring.valid", "Recording scoring status must be demo or scored."));
  }
  if (recording.immutable !== true) {
    issues.push(issue("recording.immutable.required", "Solution recordings must be immutable after creation."));
  }
  if (!positiveNumber(recording.schemaVersion)) {
    issues.push(issue("recording.schemaVersion.required", "Recording schema version must be positive."));
  }

  if (Object.hasOwn(recording as Record<string, unknown>, "rawChainOfThought")) {
    issues.push(issue("recording.rawCot.forbidden", "Raw chain-of-thought payloads are forbidden."));
  }

  return result(issues);
}

export function validateEvidenceLedger(ledger: EvidenceLedger, recording: SolutionRecording): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (ledger.recordingId !== recording.id) {
    issues.push(issue("evidence.recording.mismatch", "Evidence ledger must reference the recording."));
  }
  if (ledger.id !== recording.evidenceLedgerId) {
    issues.push(issue("evidence.id.mismatch", "Evidence ledger id must match the recording evidenceLedgerId."));
  }
  if (ledger.requiredFieldCheck !== "pass") issues.push(issue("evidence.requiredFields.pass", "Required field check must pass."));
  if (ledger.patchCleanApplyCheck !== "pass") issues.push(issue("evidence.patch.pass", "Clean apply check must pass."));
  if (ledger.verificationExitZeroCheck !== "pass") issues.push(issue("evidence.verification.pass", "Verification exit-zero check must pass."));
  if (ledger.sandboxRerunCheck !== "pass") issues.push(issue("evidence.rerun.pass", "Pinned sandbox rerun must pass."));
  if (!present(ledger.rerunJobId)) issues.push(issue("evidence.rerunJob.required", "Rerun job id is required."));
  if (!present(ledger.originalJobId)) issues.push(issue("evidence.originalJob.required", "Original job id is required."));
  if (!present(ledger.originalResultId) || !present(ledger.originalResultHash)) {
    issues.push(issue("evidence.originalResult.required", "Original result id and hash are required."));
  }
  if (!present(ledger.rerunResultId) || !present(ledger.rerunResultHash)) {
    issues.push(issue("evidence.rerunResult.required", "Rerun result id and hash are required."));
  }
  const scoredEvidence = recording.scoringStatus === "scored";
  if (scoredEvidence && ledger.originalJobId === ledger.rerunJobId) {
    issues.push(issue("evidence.rerunJob.distinct", "Rerun job must be distinct from the original job."));
  }
  if (scoredEvidence && (ledger.originalResultId === ledger.rerunResultId || ledger.originalResultHash === ledger.rerunResultHash)) {
    issues.push(issue("evidence.rerunResult.distinct", "Rerun result identity and hash must be distinct from the original result."));
  }
  if (ledger.originalJobId !== recording.originalJobId || ledger.originalResultId !== recording.originalResultId || ledger.originalResultHash !== recording.originalResultHash) {
    issues.push(issue("evidence.original.mismatch", "Evidence original identities must match the recording."));
  }
  if (scoredEvidence && (!present(ledger.oracleDescriptorHash) || ledger.oracleDescriptorHash !== recording.oracleDescriptorHash)) {
    issues.push(issue("evidence.oracle.mismatch", "Evidence oracle descriptor hash must match the recording."));
  }
  if (!present(ledger.checkerVersion)) issues.push(issue("evidence.checker.required", "Checker version is required."));
  if (!present(ledger.evidenceHash)) issues.push(issue("evidence.hash.required", "Evidence hash is required."));

  return result(issues);
}

export function canPromoteToPublicMemory(
  recording: SolutionRecording,
  ledger: EvidenceLedger,
  reviewGate: ReviewGate,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  issues.push(...validateRecording(recording).issues);
  issues.push(...validateEvidenceLedger(ledger, recording).issues);
  if (recording.scoringStatus !== "scored") {
    issues.push(issue("publicMemory.scoring.scored", "Public memory promotion requires scored hidden-oracle evidence."));
  }

  if (!present(recording.oracleDescriptorHash) || ledger.oracleDescriptorHash !== recording.oracleDescriptorHash) {
    issues.push(issue("recording.oracle.publicRequired", "Public memory promotion requires a matching opaque oracle descriptor hash."));
  }
  if (ledger.originalJobId === ledger.rerunJobId || ledger.originalResultId === ledger.rerunResultId || ledger.originalResultHash === ledger.rerunResultHash) {
    issues.push(issue("evidence.rerun.distinctRequired", "Public memory promotion requires distinct original and rerun evidence."));
  }
  if (reviewGate.recordingId !== recording.id) {
    issues.push(issue("review.recording.mismatch", "Review gate must reference the recording."));
  }
  if (reviewGate.automaticCheckStatus !== "pass") {
    issues.push(issue("review.automatic.pass", "Public memory promotion requires automatic check pass."));
  }
  if (reviewGate.trustedReviewerApprovalStatus !== "approved") {
    issues.push(issue("review.trusted.approved", "Public memory promotion requires trusted reviewer approval."));
  }
  if (!present(reviewGate.reviewerId)) {
    issues.push(issue("review.reviewer.required", "Trusted reviewer id is required for promotion."));
  }

  return result(issues);
}

export function validateMcpSearchQuery(input: Record<string, unknown>): ValidationResult {
  const issues: ValidationIssue[] = [];

  for (const key of Object.keys(input)) {
    if (!ALLOWED_MCP_QUERY_KEYS.has(key)) {
      issues.push(issue("mcp.query.key.forbidden", `MCP query key '${key}' is not allowed.`));
    }
  }
  const query = input as Partial<McpSearchQuery>;
  if (!present(query.errorSignature)) {
    issues.push(issue("mcp.query.errorSignature.required", "MCP query requires an error signature."));
  }
  if (!present(query.languageFramework)) {
    issues.push(issue("mcp.query.languageFramework.required", "MCP query requires language/framework."));
  }
  if (query.stackTraceSummary !== undefined && !present(query.stackTraceSummary)) {
    issues.push(issue("mcp.query.stackTraceSummary.nonEmpty", "Stack trace summary cannot be blank when supplied."));
  }

  return result(issues);
}

export function validateMcpSearchResult(output: Record<string, unknown>): ValidationResult {
  const issues: ValidationIssue[] = [];
  collectForbiddenPublicPayloadIssues(
    {
      actionChecklist: output.actionChecklist,
      sourceRecordingIds: output.sourceRecordingIds,
      applicabilityExplanation: output.applicabilityExplanation,
    },
    "mcp.result",
    issues,
  );

  for (const key of Object.keys(output)) {
    if (!ALLOWED_MCP_RESULT_KEYS.has(key)) {
      issues.push(issue("mcp.result.key.forbidden", `MCP result key '${key}' is not allowed.`));
    }
  }
  const resultOutput = output as Partial<McpSearchResult>;
  if (!isPublicRecordingLink(resultOutput.publicRecordingLink)) {
    issues.push(issue("mcp.result.link.required", "MCP result requires a public recording HTTPS URL or /recordings/ link."));
  }
  if (!nonEmptyStringArray(resultOutput.actionChecklist)) {
    issues.push(issue("mcp.result.checklist.required", "MCP result requires a non-empty string action checklist."));
  }
  if (!nonEmptyStringArray(resultOutput.sourceRecordingIds)) {
    issues.push(issue("mcp.result.sources.required", "MCP result requires non-empty string source recording ids."));

  }
  if (!present(resultOutput.applicabilityExplanation)) {
    issues.push(issue("mcp.result.applicability.required", "MCP result requires an applicability explanation."));
  }

  return result(issues);
}

export function validateMcpToolDefinition(tool: McpToolDefinition): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!present(tool.name)) {
    issues.push(issue("mcp.tool.name.required", "MCP tool name is required."));
  }


  if (tool.readOnly !== true) {
    issues.push(issue("mcp.tool.readOnly", "MVP MCP tools must be read-only."));
  }
  for (const key of tool.allowedInputKeys) {
    if (!ALLOWED_MCP_QUERY_KEYS.has(String(key))) {
      issues.push(issue("mcp.tool.inputKey", `MCP tool input key '${String(key)}' is forbidden.`));
    }
  }
  if (!hasRequiredSet(tool.allowedInputKeys, ["errorSignature", "languageFramework"])) {
    issues.push(issue("mcp.tool.inputRequired", "MCP tool must allow required search input keys."));
  }

  for (const key of tool.allowedOutputKeys) {
    if (!ALLOWED_MCP_RESULT_KEYS.has(String(key))) {
      issues.push(issue("mcp.tool.outputKey", `MCP tool output key '${String(key)}' is forbidden.`));
    }
  }
  if (!hasRequiredSet(tool.allowedOutputKeys, ["publicRecordingLink", "actionChecklist", "sourceRecordingIds", "applicabilityExplanation"])) {
    issues.push(issue("mcp.tool.outputRequired", "MCP tool must allow all required result keys."));
  }

  return result(issues);
}
