import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  HUMANEVAL_ADAPTER,
  HUMANEVAL_BENCHMARK,
  HUMANEVAL_PROBLEMS,
  HUMANEVAL_DEMO_PROBLEMS,
  HUMANEVAL_DESCRIPTOR_HASH_MANIFEST,
  HUMANEVAL_SCORED_PROBLEMS,
  HUMANEVAL_FULL_DESCRIPTOR_REVISION,
  HUMANEVAL_UPSTREAM_DATA_SHA256,
  HUMANEVAL_UPSTREAM_DATA_URL,
  MBPP_DESCRIPTOR_HASH_MANIFEST,
  MBPP_ADAPTER,
  MBPP_BENCHMARK,
  MBPP_PROBLEMS,
  MBPP_SCORED_PROBLEMS,
  MBPP_SELECTION_EXCLUSIONS,
  MBPP_SUBSET_DESCRIPTOR_REVISION,
  MBPP_UPSTREAM_DATA_SHA256,
  MBPP_UPSTREAM_DATA_URL,
  QUIXBUGS_ADAPTER,
  QUIXBUGS_BENCHMARK,
  QUIXBUGS_DESCRIPTOR_HASH_MANIFEST,
  QUIXBUGS_PROBLEMS,
  QUIXBUGS_PYTHON_SUBSET_DESCRIPTOR_REVISION,
  getQuixBugsProblem,
  validateQuixBugsAdapterSeed,
  SWEBENCH_LITE_ADAPTER,
  SWEBENCH_LITE_BENCHMARK,
  SWEBENCH_LITE_DESCRIPTOR_HASH_MANIFEST,
  SWEBENCH_LITE_DESCRIPTOR_REVISION,
  SWEBENCH_LITE_HARNESS_COMMIT,
  SWEBENCH_LITE_HARNESS_IMAGE_DIGEST,
  SWEBENCH_LITE_DATASET_NAME,
  SWEBENCH_LITE_DATASET_REVISION,
  SWEBENCH_LITE_PREDICTION_JSONL_SCHEMA_HASH,
  SWEBENCH_LITE_PROBLEMS,
  getSwebenchLiteProblem,
  validateSwebenchLiteAdapterSeed,
  SWEBENCH_VERIFIED_ADAPTER,
  SWEBENCH_VERIFIED_BENCHMARK,
  SWEBENCH_VERIFIED_DESCRIPTOR_HASH_MANIFEST,
  SWEBENCH_VERIFIED_DESCRIPTOR_REVISION,
  SWEBENCH_VERIFIED_HARNESS_COMMIT,
  SWEBENCH_VERIFIED_HARNESS_IMAGE_DIGEST,
  SWEBENCH_VERIFIED_DATASET_NAME,
  SWEBENCH_VERIFIED_DATASET_REVISION,
  SWEBENCH_VERIFIED_PREDICTION_JSONL_SCHEMA_HASH,
  SWEBENCH_VERIFIED_PROBLEMS,
  getSwebenchVerifiedProblem,
  validateSwebenchVerifiedAdapterSeed,
  createPatchSubmission,
  getImplementedProblemCatalog,
  getHumanEvalProblem,
  getMbppProblem,
  dockerRunArgs,
  dockerSwebenchRunArgs,
  dockerSwebenchPullArgs,
  swebenchResolvedEvidenceFromReport,
  validateSwebenchPredictionJsonl,
  swebenchHostHarnessRunArgs,
  isPinnedDockerImageDigest,
  privateOracleStdout,
  runLocalPatchVerification,
  runHiddenOraclePatchVerification,
  readRunBundles,
  openAgentOjDatabase,
  validateHumanEvalAdapterSeed,
  validateMbppAdapterSeed,
  selectCanonicalPrivateOracleDescriptor,
  validateSanitizedPrJudgeSummary,
  validatePrivateOracleDescriptor,
} from "../src/index.ts";
import type { Problem } from "../src/index.ts";
import { runCli } from "../src/cli.ts";
const passingPatch = [
  "diff --git a/solution.py b/solution.py",
  "--- a/solution.py",
  "+++ b/solution.py",
  "@@ -1,2 +1,2 @@",
  " def candidate(xs):",
  "-    return None",
  "+    return xs[0]",
  "",
].join("\n");
const alternateEntryPointPatch = [
  "diff --git a/solution.py b/solution.py",
  "--- a/solution.py",
  "+++ b/solution.py",
  "@@ -1,2 +1,5 @@",
  "+def solve(xs):",
  "+    return xs[0]",
  "+",
  " def candidate(xs):",
  "     return None",
  "",
].join("\n");
const largestPatch = [
  "diff --git a/solution.py b/solution.py",
  "--- a/solution.py",
  "+++ b/solution.py",
  "@@ -1,2 +1,2 @@",
  " def candidate(xs):",
  "-    return None",
  "+    return max(xs)",
  "",
].join("\n");

const reversePatch = [
  "diff --git a/solution.py b/solution.py",
  "--- a/solution.py",
  "+++ b/solution.py",
  "@@ -1,2 +1,2 @@",
  " def candidate(text):",
  "-    return None",
  "+    return text[::-1]",
  "",
].join("\n");
const mbppReversePatch = [
  "diff --git a/solution.py b/solution.py",
  "--- a/solution.py",
  "+++ b/solution.py",
  "@@ -1,2 +1,2 @@",
  " def candidate(text):",
  "-    return None",
  "+    return text[::-1]",
  "",
].join("\n");

const mbppCountVowelsPatch = [
  "diff --git a/solution.py b/solution.py",
  "--- a/solution.py",
  "+++ b/solution.py",
  "@@ -1,2 +1,2 @@",
  " def candidate(text):",
  "-    return None",
  "+    return sum(1 for ch in text.lower() if ch in 'aeiou')",
  "",
].join("\n");

const mbppSumUniquePatch = [
  "diff --git a/solution.py b/solution.py",
  "--- a/solution.py",
  "+++ b/solution.py",
  "@@ -1,2 +1,2 @@",
  " def candidate(values):",
  "-    return None",
  "+    return sum(set(values))",
  "",
].join("\n");

const judgeAssetPatch = [
  "diff --git a/tests/test_humaneval.py b/tests/test_humaneval.py",
  "--- a/tests/test_humaneval.py",
  "+++ b/tests/test_humaneval.py",
  "@@ -7,2 +7,2 @@ class CandidateTest(unittest.TestCase):",
  "     def test_returns_first_element(self):",
  "-        self.assertEqual(candidate([3, 2, 1]), 3)",
  "+        self.assertEqual(candidate([3, 2, 1]), None)",
  "",
].join("\n");

const publicOverfitPatch = [
  "diff --git a/solution.py b/solution.py",
  "--- a/solution.py",
  "+++ b/solution.py",
  "@@ -1,2 +1,6 @@",
  " def candidate(xs):",
  "-    return None",
  "+    if len(xs) == 3 and xs[0] == 3 and xs[1] == 2 and xs[2] == 1:",
  "+        return 3",
  "+    if len(xs) == 2 and not isinstance(xs[0], int):",
  "+        return xs[0]",
  "+    return None",
  "",
].join("\n");

const testsInspectionPatch = [
  "diff --git a/solution.py b/solution.py",
  "--- a/solution.py",
  "+++ b/solution.py",
  "@@ -1,2 +1,4 @@",
  "+import os",
  "+",
  " def candidate(xs):",
  "-    return None",
  "+    return xs[0] if os.path.exists('/work/tests') else None",
  "",
].join("\n");

const unittestMonkeypatchPatch = [
  "diff --git a/solution.py b/solution.py",
  "--- a/solution.py",
  "+++ b/solution.py",
  "@@ -1,2 +1,5 @@",
  "+import unittest",
  "+unittest.TestCase.assertEqual = lambda *args, **kwargs: None",
  "+",
  " def candidate(xs):",
  "-    return None",
  "+    return None",
  "",
].join("\n");

const importHookTamperingPatch = [
  "diff --git a/solution.py b/solution.py",
  "--- a/solution.py",
  "+++ b/solution.py",
  "@@ -1,2 +1,5 @@",
  "+import sys",
  "+sys.meta_path.clear()",
  "+",
  " def candidate(xs):",
  "-    return None",
  "+    return None",
  "",
].join("\n");

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

interface HumanEvalUpstreamTask {
  task_id: string;
  entry_point: string;
  test: string;
}

interface MbppUpstreamTask {
  task_id: number;
  prompt: string;
  code: string;
  test_imports: string[];
  test_list: string[];
}


async function fetchPinnedHumanEvalTasks(): Promise<HumanEvalUpstreamTask[]> {
  const response = await fetch(HUMANEVAL_UPSTREAM_DATA_URL);
  assert.equal(response.ok, true);
  const raw = Buffer.from(await response.arrayBuffer());
  assert.equal(`sha256:${sha256(raw)}`, HUMANEVAL_UPSTREAM_DATA_SHA256);
  return gunzipSync(raw)
    .toString("utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as HumanEvalUpstreamTask);
}

async function fetchPinnedMbppTasks(): Promise<MbppUpstreamTask[]> {
  const response = await fetch(MBPP_UPSTREAM_DATA_URL);
  assert.equal(response.ok, true);
  const raw = Buffer.from(await response.arrayBuffer());
  assert.equal(`sha256:${sha256(raw)}`, MBPP_UPSTREAM_DATA_SHA256);
  return JSON.parse(raw.toString("utf8")) as MbppUpstreamTask[];
}

function officialMbppEvidencePolicy(problemId: string): { originalEvidenceId: string; rerunEvidenceId: string } {
  return {
    originalEvidenceId: `${problemId}-private-original-evidence`,
    rerunEvidenceId: `${problemId}-private-rerun-evidence`,
  };
}

function officialMbppDescriptor(problem: Problem, entryPoint: string, cases: Array<{ id: string; args: unknown[]; expected: unknown }>): string {
  return JSON.stringify({
    schemaVersion: 2,
    problemId: problem.id,
    benchmarkId: problem.benchmarkId,
    adapterId: problem.adapterId,
    upstreamTaskId: problem.upstreamTaskId,
    oracleKind: "python-function-cases",
    entryPoint,
    cases,
    evidencePolicy: officialMbppEvidencePolicy(problem.id),
    descriptorRevision: MBPP_SUBSET_DESCRIPTOR_REVISION,
  });
}
function extractMbppCasesWithPython(task: MbppUpstreamTask, entryPoint: string): Array<{ id: string; args: unknown[]; expected: unknown }> {
  const script = `
import ast
import json
import sys

payload = json.load(sys.stdin)
cases = []
for index, source in enumerate(payload["test_list"]):
    parsed = ast.parse(source)
    if len(parsed.body) != 1 or not isinstance(parsed.body[0], ast.Assert):
        raise ValueError(f"unsupported MBPP assert: {source}")
    assertion = parsed.body[0].test
    if not isinstance(assertion, ast.Compare) or len(assertion.ops) != 1 or not isinstance(assertion.ops[0], ast.Eq) or len(assertion.comparators) != 1:
        raise ValueError(f"unsupported MBPP comparison: {source}")
    call = assertion.left
    if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Name) or call.func.id != payload["entryPoint"] or call.keywords:
        raise ValueError(f"unsupported MBPP call target: {source}")
    cases.append({
        "id": f"mbpp-{payload['task_id']}-case-{index + 1}",
        "args": [ast.literal_eval(arg) for arg in call.args],
        "expected": ast.literal_eval(assertion.comparators[0]),
    })
json.dump(cases, sys.stdout, separators=(",", ":"))
`;
  const result = spawnSync("python3", ["-c", script], {
    input: JSON.stringify({ task_id: task.task_id, entryPoint, test_list: task.test_list }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Array<{ id: string; args: unknown[]; expected: unknown }>;
}

function officialHumanEvalEvidencePolicy(problemId: string): { originalEvidenceId: string; rerunEvidenceId: string } {
  return {
    originalEvidenceId: `${problemId}-private-original-evidence`,
    rerunEvidenceId: `${problemId}-private-rerun-evidence`,
  };
}

function officialHumanEvalDescriptor(problem: Problem, task: HumanEvalUpstreamTask): string {
  return JSON.stringify({
    schemaVersion: 2,
    problemId: problem.id,
    benchmarkId: problem.benchmarkId,
    adapterId: problem.adapterId,
    upstreamTaskId: task.task_id,
    oracleKind: "python-function-tests",
    entryPoint: task.entry_point,
    testSource: task.test,
    testSourceHash: `sha256:${sha256(task.test)}`,
    evidencePolicy: officialHumanEvalEvidencePolicy(problem.id),
    descriptorRevision: HUMANEVAL_FULL_DESCRIPTOR_REVISION,
  });
}

function withPrivateOracle<T>(problem: Problem, cases: Array<{ id: string; args: unknown[]; expected: unknown }>, callback: (problem: Problem) => T): T {
  const descriptor = JSON.stringify({
    schemaVersion: 2,
    problemId: problem.id,
    benchmarkId: problem.benchmarkId,
    adapterId: problem.adapterId,
    upstreamTaskId: problem.upstreamTaskId,
    oracleKind: "python-function-cases",
    entryPoint: "candidate",
    cases,
    evidencePolicy: {
      originalEvidenceId: `${problem.id}-original-private-evidence`,
      rerunEvidenceId: `${problem.id}-rerun-private-evidence`,
    },
  });
  const previousJson = process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON;
  const previousPath = process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_PATH;
  process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON = descriptor;
  delete process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_PATH;
  try {
    return callback({
      ...problem,
      scoringMode: "scored-hidden",
      oracleMetadata: {
        kind: "generated-private",
        hiddenRequired: true,
        oracleDescriptorHash: `sha256:${sha256(descriptor)}`,
        originalEvidenceId: `${problem.id}-original-private-evidence`,
        rerunEvidenceId: `${problem.id}-rerun-private-evidence`,
      },
    });
  } finally {
    if (previousJson === undefined) {
      delete process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON;
    } else {
      process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON = previousJson;
    }
    if (previousPath === undefined) {
      delete process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_PATH;
    } else {
      process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_PATH = previousPath;
    }
  }
}

function withVersionedPrivateOracle<T>(problem: Problem, cases: Array<{ id: string; args: unknown[]; expected: unknown }>, callback: (problem: Problem) => T, entryPoint = "candidate"): T {
  const descriptor = JSON.stringify({
    schemaVersion: 2,
    problemId: problem.id,
    benchmarkId: problem.benchmarkId,
    adapterId: problem.adapterId,
    upstreamTaskId: problem.upstreamTaskId,
    oracleKind: "python-function-cases",
    entryPoint,
    cases,
    evidencePolicy: {
      originalEvidenceId: `${problem.id}-original-v2-evidence`,
      rerunEvidenceId: `${problem.id}-rerun-v2-evidence`,
    },
  });
  const previousJson = process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON;
  const previousPath = process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_PATH;
  const previousUnsafeLocal = process.env.AGENTOJ_ALLOW_UNSAFE_LOCAL_HIDDEN_ORACLE;
  process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON = descriptor;
  delete process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_PATH;
  process.env.AGENTOJ_ALLOW_UNSAFE_LOCAL_HIDDEN_ORACLE = "1";
  try {
    return callback({
      ...problem,
      scoringMode: "scored-hidden",
      oracleMetadata: {
        kind: "generated-private",
        hiddenRequired: true,
        oracleDescriptorHash: `sha256:${sha256(descriptor)}`,
        originalEvidenceId: `${problem.id}-original-v2-evidence`,
        rerunEvidenceId: `${problem.id}-rerun-v2-evidence`,
      },
    });
  } finally {
    if (previousJson === undefined) {
      delete process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON;
    } else {
      process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON = previousJson;
    }
    if (previousPath === undefined) {
      delete process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_PATH;
    } else {
      process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_PATH = previousPath;
    }
    if (previousUnsafeLocal === undefined) {
      delete process.env.AGENTOJ_ALLOW_UNSAFE_LOCAL_HIDDEN_ORACLE;
    } else {
      process.env.AGENTOJ_ALLOW_UNSAFE_LOCAL_HIDDEN_ORACLE = previousUnsafeLocal;
    }
  }
}

function prSubmissionEnvelope(problemId: string, adapterId: string, patch: string) {
  return {
    schemaVersion: 1,
    id: `pr-${problemId}`,
    problemId,
    adapterId,
    prHeadSha: "0123456789abcdef0123456789abcdef01234567",
    patchSha256: `sha256:${sha256(patch)}`,
    patchBytes: Buffer.byteLength(patch),
    patchStats: {
      filesChanged: 1,
      locAdded: patch.split(/\r?\n/).filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
      locDeleted: patch.split(/\r?\n/).filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
    },
    files: [{ path: "solution.py", changeType: "modify", gitMode: "100644", byteSize: 512, isBinary: false, isSymlink: false }],
    publicSubmission: true,
  };
}

const judgeOptions = {
  enabledProblemIds: [...HUMANEVAL_PROBLEMS, ...MBPP_PROBLEMS].map((problem) => problem.id),
  enabledAdapterIds: [HUMANEVAL_ADAPTER.id, MBPP_ADAPTER.id],
};


describe("HumanEval adapter seed", () => {
  it("pins a permissive upstream benchmark and validates the seeded problems", async () => {
    assert.doesNotThrow(() => validateHumanEvalAdapterSeed());
    assert.equal(HUMANEVAL_BENCHMARK.licenseId, "MIT");
    assert.equal(HUMANEVAL_BENCHMARK.legalStatus, "approved");
    assert.equal(HUMANEVAL_ADAPTER.supportedHostingModes.includes("hosted"), true);
    assert.equal(HUMANEVAL_ADAPTER.supportedHostingModes.includes("adapter-only"), true);
    assert.equal(HUMANEVAL_DEMO_PROBLEMS.length, 3);
    assert.equal(HUMANEVAL_SCORED_PROBLEMS.length, 164);
    assert.equal(HUMANEVAL_PROBLEMS.length, 167);
    assert.equal(HUMANEVAL_DESCRIPTOR_HASH_MANIFEST.length, 164);
    assert.equal(getHumanEvalProblem("humaneval-001")?.upstreamTaskId, "HumanEval/1");
    assert.equal(getHumanEvalProblem("humaneval-full-000")?.upstreamTaskId, "HumanEval/0");
    assert.equal(getHumanEvalProblem("humaneval-full-163")?.upstreamTaskId, "HumanEval/163");
    assert.equal(getHumanEvalProblem("humaneval-full-000")?.scoringMode, "scored-hidden");
    assert.match(getHumanEvalProblem("humaneval-full-000")?.oracleMetadata?.oracleDescriptorHash ?? "", /^sha256:[0-9a-f]{64}$/);
    assert.equal("originalEvidenceId" in (getHumanEvalProblem("humaneval-full-000")?.oracleMetadata ?? {}), false);
    assert.equal("rerunEvidenceId" in (getHumanEvalProblem("humaneval-full-000")?.oracleMetadata ?? {}), false);
    assert.deepEqual(getHumanEvalProblem("humaneval-001")?.editableFilePaths, ["solution.py"]);
    assert.equal(getHumanEvalProblem("humaneval-003-adapter-only")?.hostingMode, "adapter-only");
    const tasks = await fetchPinnedHumanEvalTasks();
    assert.equal(tasks.length, 164);
    const seenHashes = new Set<string>();
    for (const [index, entry] of HUMANEVAL_DESCRIPTOR_HASH_MANIFEST.entries()) {
      const id = `humaneval-full-${String(index).padStart(3, "0")}`;
      const problem = getHumanEvalProblem(id);
      const task = tasks[index];
      assert.ok(problem);
      assert.equal(entry.problemId, id);
      assert.equal(problem.id, entry.problemId);
      assert.equal(problem.upstreamTaskId, task.task_id);
      assert.equal(entry.upstreamTaskId, task.task_id);
      assert.equal(entry.entryPoint, task.entry_point);
      assert.equal(problem.scoringMode, "scored-hidden");
      assert.equal(problem.oracleMetadata?.hiddenRequired, true);
      assert.equal(problem.oracleMetadata?.oracleDescriptorHash, entry.oracleDescriptorHash);
      assert.equal("originalEvidenceId" in entry, false);
      assert.equal("rerunEvidenceId" in entry, false);
      assert.match(entry.oracleDescriptorHash, /^sha256:[0-9a-f]{64}$/);
      assert.equal(seenHashes.has(entry.oracleDescriptorHash), false);
      seenHashes.add(entry.oracleDescriptorHash);
    }
  });
});

describe("MBPP adapter seed and subset-50 scored catalog", () => {
  it("pins Apache-2.0 metadata and validates adapter-only seeded problems", () => {
    assert.doesNotThrow(() => validateMbppAdapterSeed());
    assert.equal(MBPP_BENCHMARK.licenseId, "Apache-2.0");
    assert.equal(MBPP_BENCHMARK.legalStatus, "approved");
    assert.equal(MBPP_BENCHMARK.defaultHostingMode, "hosted");
    assert.deepEqual(MBPP_ADAPTER.supportedHostingModes, ["adapter-only", "hosted"]);
    assert.equal(MBPP_ADAPTER.defaultResources.networkPolicy, "blocked");
    assert.equal(MBPP_PROBLEMS.length, 53);
    assert.equal(getMbppProblem("mbpp-001-adapter-only")?.upstreamTaskId, "MBPP/adapter-seed-001");
    assert.equal(getMbppProblem("mbpp-001-adapter-only")?.hostingMode, "adapter-only");
    assert.equal(MBPP_SCORED_PROBLEMS.length, 50);
    assert.equal(MBPP_DESCRIPTOR_HASH_MANIFEST.length, 50);
    assert.equal(getMbppProblem("mbpp-full-003")?.scoringMode, "scored-hidden");
    assert.equal(getMbppProblem("mbpp-full-104")?.upstreamTaskId, "MBPP/104");
    assert.equal(MBPP_SELECTION_EXCLUSIONS.some((entry) => entry.taskId === 2 && /direct selected function/.test(entry.reason)), true);
    assert.equal(MBPP_SELECTION_EXCLUSIONS.some((entry) => entry.taskId === 82 && /imports/.test(entry.reason)), true);
  });

  it("pins MBPP subset-50-v1 to real upstream tasks and keeps private cases out of public metadata", async () => {
    const tasks = await fetchPinnedMbppTasks();
    const byId = new Map(tasks.map((task) => [task.task_id, task]));
    const seenHashes = new Set<string>();
    for (const entry of MBPP_DESCRIPTOR_HASH_MANIFEST) {
      const problem = getMbppProblem(entry.problemId);
      const task = byId.get(entry.taskId);
      assert.ok(problem);
      assert.ok(task);
      assert.equal(problem.upstreamTaskId, `MBPP/${entry.taskId}`);
      assert.equal(entry.upstreamTaskId, `MBPP/${entry.taskId}`);
      assert.equal(problem.scoringMode, "scored-hidden");
      assert.equal(problem.oracleMetadata?.hiddenRequired, true);
      assert.equal(problem.oracleMetadata?.oracleDescriptorHash, entry.oracleDescriptorHash);
      assert.equal("originalEvidenceId" in entry, false);
      assert.equal("rerunEvidenceId" in entry, false);
      assert.equal("test_list" in entry, false);
      assert.equal("code" in entry, false);
      assert.match(entry.oracleDescriptorHash, /^sha256:[0-9a-f]{64}$/);
      assert.equal(seenHashes.has(entry.oracleDescriptorHash), false);
      seenHashes.add(entry.oracleDescriptorHash);
      const cases = extractMbppCasesWithPython(task, entry.entryPoint);
      assert.equal(entry.oracleDescriptorHash, `sha256:${sha256(officialMbppDescriptor(problem, entry.entryPoint, cases))}`);
    }
  });
});

function officialQuixBugsCommandDescriptor(problem: Problem, testSource: string): string {
  const testSourceHash = `sha256:${sha256(testSource)}`;
  return JSON.stringify({
    schemaVersion: 2,
    problemId: problem.id,
    benchmarkId: problem.benchmarkId,
    adapterId: problem.adapterId,
    upstreamTaskId: problem.upstreamTaskId,
    oracleKind: "command-hidden-tests",
    commandId: "pytest-hidden",
    allowedTargets: problem.editableFilePaths,
    hiddenTestBundleHash: testSourceHash,
    expectedExitCode: 0,
    testSource,
    testSourceHash,
    evidencePolicy: {
      originalEvidenceId: `${problem.id}-private-original-evidence`,
      rerunEvidenceId: `${problem.id}-private-rerun-evidence`,
    },
    descriptorRevision: QUIXBUGS_PYTHON_SUBSET_DESCRIPTOR_REVISION,
  });
}

const quixBugsSyntheticHiddenTestSource = [
  "from python_programs.bitcount import bitcount",
  "",
  "def test_synthetic_bitcount_command_hidden_cases():",
  "    assert bitcount(0) == 0",
  "    assert bitcount(1) == 1",
  "    assert bitcount(7) == 3",
  "    assert bitcount(128) == 1",
  "",
].join("\n");

const quixBugsBitcountPatch = [
  "diff --git a/python_programs/bitcount.py b/python_programs/bitcount.py",
  "--- a/python_programs/bitcount.py",
  "+++ b/python_programs/bitcount.py",
  "@@ -1,6 +1,6 @@",
  " def bitcount(n):",
  "     count = 0",
  "     while n:",
  "-        n ^= n - 1",
  "+        n &= n - 1",
  "         count += 1",
  "     return count",
  "",
].join("\n");

const quixBugsNonAllowlistedPatch = [
  "diff --git a/python_programs/bitcount_test.py b/python_programs/bitcount_test.py",
  "--- a/python_programs/bitcount_test.py",
  "+++ b/python_programs/bitcount_test.py",
  "@@ -0,0 +1,1 @@",
  "+assert False",
  "",
].join("\n");
const quixBugsEarlyExitPatch = [
  "diff --git a/python_programs/bitcount.py b/python_programs/bitcount.py",
  "--- a/python_programs/bitcount.py",
  "+++ b/python_programs/bitcount.py",
  "@@ -1,3 +1,6 @@",
  "+import os",
  "+os._exit(0)",
  "+",
  " def bitcount(n):",
  "     count = 0",
  "     while n:",
  "",
].join("\n");
const quixBugsForgedReportPatch = [
  "diff --git a/python_programs/bitcount.py b/python_programs/bitcount.py",
  "--- a/python_programs/bitcount.py",
  "+++ b/python_programs/bitcount.py",
  "@@ -1,3 +1,10 @@",
  "+import glob",
  "+import os",
  "+import pathlib",
  "+for report in glob.glob('/tmp/agentoj-hidden-*/pytest-session.json'):",
  "+    pathlib.Path(report).write_text('{\"exitstatus\":0,\"testscollected\":1,\"testsfailed\":0}')",
  "+os._exit(0)",
  "+",
  " def bitcount(n):",
  "     count = 0",
  "     while n:",
  "",
].join("\n");

describe("QuixBugs Python subset-10 scored catalog", () => {
  it("pins real QuixBugs Python metadata and keeps command-hidden descriptors private", () => {
    assert.doesNotThrow(() => validateQuixBugsAdapterSeed());
    assert.equal(QUIXBUGS_BENCHMARK.upstreamCommitOrVersion, "4257f44b0ff1181dedaedee6a447e133219fcebf");
    assert.equal(QUIXBUGS_ADAPTER.supportedHostingModes.includes("hosted"), true);
    assert.equal(QUIXBUGS_PROBLEMS.length, 10);
    assert.equal(QUIXBUGS_DESCRIPTOR_HASH_MANIFEST.length, 10);
    assert.deepEqual(QUIXBUGS_DESCRIPTOR_HASH_MANIFEST.map((entry) => entry.upstreamTaskId).slice(0, 3), ["bitcount", "breadth_first_search", "bucketsort"]);
    for (const entry of QUIXBUGS_DESCRIPTOR_HASH_MANIFEST) {
      const problem = getQuixBugsProblem(entry.problemId);
      assert.ok(problem);
      assert.equal(problem.scoringMode, "scored-hidden");
      assert.deepEqual(problem.editableFilePaths, [entry.editableFilePath]);
      assert.equal(problem.oracleMetadata?.oracleDescriptorHash, entry.oracleDescriptorHash);
      assert.equal("testSource" in entry, false);
      assert.equal("cases" in entry, false);
      assert.match(entry.oracleDescriptorHash, /^sha256:[0-9a-f]{64}$/);
    }
  });
  it("validates QuixBugs private descriptor bundles when the secret artifact is mounted", () => {
    const rawBundle = process.env.AGENTOJ_QUIXBUGS_PRIVATE_DESCRIPTOR_BUNDLE_JSON;
    if (!rawBundle) {
      assert.equal(QUIXBUGS_DESCRIPTOR_HASH_MANIFEST.every((entry) => !("testSource" in entry) && !("hiddenTestBundleHash" in entry)), true);
      return;
    }

    const parsedBundle = JSON.parse(rawBundle) as unknown;
    let checked = 0;
    for (const entry of QUIXBUGS_DESCRIPTOR_HASH_MANIFEST) {
      const problem = getQuixBugsProblem(entry.problemId);
      assert.ok(problem);
      const selected = selectCanonicalPrivateOracleDescriptor(
        {
          problemId: problem.id,
          benchmarkId: problem.benchmarkId,
          adapterId: problem.adapterId,
          upstreamTaskId: problem.upstreamTaskId,
          expectedOracleDescriptorHash: entry.oracleDescriptorHash,
        },
        parsedBundle,
      );
      assert.ok(selected);
      assert.equal(`sha256:${sha256(selected.canonicalJson)}`, entry.oracleDescriptorHash);
      const descriptor = JSON.parse(selected.canonicalJson) as unknown;
      assert.equal(
        validatePrivateOracleDescriptor(descriptor, {
          problemId: problem.id,
          benchmarkId: problem.benchmarkId,
          adapterId: problem.adapterId,
          upstreamTaskId: problem.upstreamTaskId,
        }).ok,
        true,
      );
      checked += 1;
    }
    assert.equal(checked, 10);
  });


  it("runs a synthetic QuixBugs command-hidden descriptor and rejects non-allowlisted targets", () => {
    const catalogProblem = getQuixBugsProblem("quixbugs-python-bitcount");
    assert.ok(catalogProblem);
    const smokeProblem: Problem = {
      ...catalogProblem,
      id: "quixbugs-python-command-hidden-smoke",
      oracleMetadata: {
        kind: "generated-private",
        hiddenRequired: true,
        oracleDescriptorHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      },
    };
    const descriptor = officialQuixBugsCommandDescriptor(smokeProblem, quixBugsSyntheticHiddenTestSource);
    const problem: Problem = {
      ...smokeProblem,
      oracleMetadata: {
        kind: "generated-private",
        hiddenRequired: true,
        oracleDescriptorHash: `sha256:${sha256(descriptor)}`,
      },
    };

    const previousJson = process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON;
    const previousUnsafeLocal = process.env.AGENTOJ_ALLOW_UNSAFE_LOCAL_HIDDEN_ORACLE;
    process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON = descriptor;
    process.env.AGENTOJ_ALLOW_UNSAFE_LOCAL_HIDDEN_ORACLE = "1";
    try {
      const passed = runHiddenOraclePatchVerification({
        benchmark: QUIXBUGS_BENCHMARK,
        adapter: QUIXBUGS_ADAPTER,
        problem,
        submission: createPatchSubmission(problem, "quixbugs-bitcount-command-hidden-pass"),
        patch: quixBugsBitcountPatch,
        fixtureDir: "fixtures/quixbugs-python-bitcount",
      });
      assert.equal(passed.result.passFail, "pass");
      assert.equal(passed.job.scoringStatus, "scored");
      assert.equal(passed.stdout, "");
      assert.equal(passed.job.oracleDescriptorHash, problem.oracleMetadata?.oracleDescriptorHash);

      const failed = runHiddenOraclePatchVerification({
        benchmark: QUIXBUGS_BENCHMARK,
        adapter: QUIXBUGS_ADAPTER,
        problem,
        submission: createPatchSubmission(problem, "quixbugs-bitcount-command-hidden-fail"),
        patch: quixBugsNonAllowlistedPatch,
        fixtureDir: "fixtures/quixbugs-python-bitcount",
      });
      assert.equal(failed.result.passFail, "fail");
      assert.match(failed.stderr, /not editable|not allowed by private descriptor/);

      const bypass = runHiddenOraclePatchVerification({
        benchmark: QUIXBUGS_BENCHMARK,
        adapter: QUIXBUGS_ADAPTER,
        problem,
        submission: createPatchSubmission(problem, "quixbugs-bitcount-command-hidden-early-exit"),
        patch: quixBugsEarlyExitPatch,
        fixtureDir: "fixtures/quixbugs-python-bitcount",
      });
      assert.equal(bypass.result.passFail, "fail");
      assert.match(bypass.stderr, /command hidden oracle failed/);
      const forgedReportBypass = runHiddenOraclePatchVerification({
        benchmark: QUIXBUGS_BENCHMARK,
        adapter: QUIXBUGS_ADAPTER,
        problem,
        submission: createPatchSubmission(problem, "quixbugs-bitcount-command-hidden-forged-report"),
        patch: quixBugsForgedReportPatch,
        fixtureDir: "fixtures/quixbugs-python-bitcount",
      });
      assert.equal(forgedReportBypass.result.passFail, "fail");
      assert.match(forgedReportBypass.stderr, /command hidden oracle failed/);
      const dockerArgs = dockerRunArgs(
        {
          benchmark: QUIXBUGS_BENCHMARK,
          adapter: QUIXBUGS_ADAPTER,
          problem,
          submission: createPatchSubmission(problem, "quixbugs-bitcount-docker-args"),
          patch: quixBugsBitcountPatch,
        },
        "fixtures/quixbugs-python-bitcount",
      );
      const dockerArgvJson = JSON.stringify(dockerArgs);
      assert.equal(dockerArgvJson.includes(quixBugsSyntheticHiddenTestSource), false);
      assert.equal(dockerArgvJson.includes("private-original-evidence"), false);
      assert.equal(dockerArgvJson.includes("bitcount_test.py"), false);
      assert.ok(dockerArgs.some((arg) => arg.endsWith("python_programs/bitcount.py:/target0:ro,z")));
    } finally {
      if (previousJson === undefined) {
        delete process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON;
      } else {
        process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON = previousJson;
      }
      if (previousUnsafeLocal === undefined) {
        delete process.env.AGENTOJ_ALLOW_UNSAFE_LOCAL_HIDDEN_ORACLE;
      } else {
        process.env.AGENTOJ_ALLOW_UNSAFE_LOCAL_HIDDEN_ORACLE = previousUnsafeLocal;
      }
    }
  });
});

function officialSwebenchLiteDescriptor(problem: Problem): string {
  const entry = SWEBENCH_LITE_DESCRIPTOR_HASH_MANIFEST.find((candidate) => candidate.problemId === problem.id);
  assert.ok(entry);
  return JSON.stringify({
    schemaVersion: 2,
    problemId: problem.id,
    benchmarkId: problem.benchmarkId,
    adapterId: problem.adapterId,
    upstreamTaskId: problem.upstreamTaskId,
    oracleKind: "swebench-upstream-harness",
    datasetName: SWEBENCH_LITE_DATASET_NAME,
    datasetRevision: SWEBENCH_LITE_DATASET_REVISION,
    split: "test",
    instanceId: entry.instanceId,
    repo: entry.repo,
    baseCommit: entry.baseCommit,
    harnessCommit: SWEBENCH_LITE_HARNESS_COMMIT,
    harnessImageDigest: SWEBENCH_LITE_HARNESS_IMAGE_DIGEST,
    predictionJsonlSchemaHash: SWEBENCH_LITE_PREDICTION_JSONL_SCHEMA_HASH,
    cacheKey: `swebench:${SWEBENCH_LITE_HARNESS_COMMIT}:${SWEBENCH_LITE_DATASET_REVISION}:${SWEBENCH_LITE_HARNESS_IMAGE_DIGEST}`,
    evidencePolicy: {
      originalEvidenceId: `${problem.id}-original-harness-log`,
      rerunEvidenceId: `${problem.id}-rerun-harness-log`,
    },
    descriptorRevision: SWEBENCH_LITE_DESCRIPTOR_REVISION,
  });
}
function officialSwebenchVerifiedDescriptor(problem: Problem): string {
  const entry = SWEBENCH_VERIFIED_DESCRIPTOR_HASH_MANIFEST.find((candidate) => candidate.problemId === problem.id);
  assert.ok(entry);
  return JSON.stringify({
    schemaVersion: 2,
    problemId: problem.id,
    benchmarkId: problem.benchmarkId,
    adapterId: problem.adapterId,
    upstreamTaskId: problem.upstreamTaskId,
    oracleKind: "swebench-upstream-harness",
    datasetName: SWEBENCH_VERIFIED_DATASET_NAME,
    datasetRevision: SWEBENCH_VERIFIED_DATASET_REVISION,
    split: "test",
    instanceId: entry.instanceId,
    repo: entry.repo,
    baseCommit: entry.baseCommit,
    harnessCommit: SWEBENCH_VERIFIED_HARNESS_COMMIT,
    harnessImageDigest: SWEBENCH_VERIFIED_HARNESS_IMAGE_DIGEST,
    predictionJsonlSchemaHash: SWEBENCH_VERIFIED_PREDICTION_JSONL_SCHEMA_HASH,
    cacheKey: `swebench:${SWEBENCH_VERIFIED_HARNESS_COMMIT}:${SWEBENCH_VERIFIED_DATASET_REVISION}:${SWEBENCH_VERIFIED_HARNESS_IMAGE_DIGEST}`,
    evidencePolicy: {
      originalEvidenceId: `${problem.id}-original-harness-log`,
      rerunEvidenceId: `${problem.id}-rerun-harness-log`,
    },
    descriptorRevision: SWEBENCH_VERIFIED_DESCRIPTOR_REVISION,
  });
}

const swebenchLitePatch = [
  "diff --git a/astropy/modeling/separable.py b/astropy/modeling/separable.py",
  "--- a/astropy/modeling/separable.py",
  "+++ b/astropy/modeling/separable.py",
  "@@ -242,1 +242,1 @@",
  "-        cright[-right.shape[0]:, -right.shape[1]:] = 1",
  "+        cright[-right.shape[0]:, -right.shape[1]:] = right",
  "",
].join("\n");

describe("SWE-bench Lite official harness scored surface", () => {
  it("pins a real official-harness Lite instance with private descriptor hash only", () => {
    assert.doesNotThrow(() => validateSwebenchLiteAdapterSeed());
    assert.equal(SWEBENCH_LITE_BENCHMARK.id, "swe-bench-lite");
    assert.equal(SWEBENCH_LITE_BENCHMARK.upstreamCommitOrVersion, SWEBENCH_LITE_HARNESS_COMMIT);
    assert.equal(SWEBENCH_LITE_DATASET_REVISION, "6ec7bb89b9342f664a54a6e0a6ea6501d3437cc2");
    assert.equal(SWEBENCH_LITE_HARNESS_COMMIT, "f7bbbb2ccdf479001d6467c9e34af59e44a840f9");
    assert.equal(
      SWEBENCH_LITE_HARNESS_IMAGE_DIGEST,
      "swebench/sweb.eval.x86_64.astropy_1776_astropy-12907@sha256:f3f63bb87d581c0e7b47f900dd82165b71040e1758d3c29e915e2b18da9baf63",
    );
    assert.equal(SWEBENCH_LITE_PREDICTION_JSONL_SCHEMA_HASH, "sha256:1f4f2da592ab5373104554cc3c55408feb0209c9fd32ff3bc603e81ad4933236");
    assert.equal(SWEBENCH_LITE_ADAPTER.defaultResources.timeoutSeconds, 2700);
    assert.equal(SWEBENCH_LITE_ADAPTER.defaultResources.memoryMb, 6144);
    assert.equal(SWEBENCH_LITE_ADAPTER.defaultResources.cpuCores, 2);
    assert.equal(SWEBENCH_LITE_PROBLEMS.length, 1);
    const problem = getSwebenchLiteProblem("swe-bench-lite-astropy-12907");
    assert.ok(problem);
    assert.equal(problem.scoringMode, "scored-hidden");
    assert.equal(problem.hostingMode, "adapter-only");
    assert.equal(problem.oracleMetadata?.oracleDescriptorHash, `sha256:${sha256(officialSwebenchLiteDescriptor(problem))}`);
    assert.equal(JSON.stringify(problem).includes("harnessCommit"), false);
    assert.equal(JSON.stringify(problem).includes("predictionJsonlSchemaHash"), false);
    assert.equal(SWEBENCH_LITE_HARNESS_IMAGE_DIGEST.includes("bbbbbbbb"), false);
    assert.equal(SWEBENCH_LITE_HARNESS_COMMIT.includes("9f6c4d2a1b0e5f3c8d7a6b5c4e3f2a1908d7c6b5"), false);
  });

  it("validates SWE-bench Lite private descriptor when the secret artifact is mounted", () => {
    const problem = getSwebenchLiteProblem("swe-bench-lite-astropy-12907");
    assert.ok(problem);
    const selected = selectCanonicalPrivateOracleDescriptor(
      {
        problemId: problem.id,
        benchmarkId: problem.benchmarkId,
        adapterId: problem.adapterId,
        upstreamTaskId: problem.upstreamTaskId,
        expectedOracleDescriptorHash: problem.oracleMetadata?.oracleDescriptorHash,
      },
      JSON.parse(officialSwebenchLiteDescriptor(problem)) as unknown,
    );
    assert.ok(selected);
    assert.equal(`sha256:${sha256(selected.canonicalJson)}`, problem.oracleMetadata?.oracleDescriptorHash);
    assert.equal(
      validatePrivateOracleDescriptor(JSON.parse(selected.canonicalJson) as unknown, {
        problemId: problem.id,
        benchmarkId: problem.benchmarkId,
        adapterId: problem.adapterId,
        upstreamTaskId: problem.upstreamTaskId,
      }).ok,
      true,
    );
  });

  it("keeps missing SWE-bench descriptor secrets fail-closed and public-only", () => {
    const problem = getSwebenchLiteProblem("swe-bench-lite-astropy-12907");
    assert.ok(problem);
    assert.equal(SWEBENCH_LITE_DESCRIPTOR_HASH_MANIFEST.every((entry) => !("harnessImageDigest" in entry)), true);
    assert.equal(problem.oracleMetadata?.oracleDescriptorHash, `sha256:${sha256(officialSwebenchLiteDescriptor(problem))}`);
  });

  it("constructs official harness Docker argv without leaking patch text or descriptor internals", () => {
    const problem = getSwebenchLiteProblem("swe-bench-lite-astropy-12907");
    assert.ok(problem);
    const descriptor = JSON.parse(officialSwebenchLiteDescriptor(problem)) as {
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
      evidencePolicy: { originalEvidenceId: string; rerunEvidenceId: string };
    };
    const dir = mkdtempSync(join(tmpdir(), "agentoj-swebench-"));
    const predictionPath = join(dir, "predictions.jsonl");
    writeFileSync(predictionPath, JSON.stringify({ instance_id: descriptor.instanceId, model_name_or_path: "open-agent-judge-pr", model_patch: swebenchLitePatch }) + "\n", "utf8");
    const input = {
      benchmark: SWEBENCH_LITE_BENCHMARK,
      adapter: SWEBENCH_LITE_ADAPTER,
      problem,
      submission: createPatchSubmission(problem, "swebench-lite-docker-args"),
      patch: swebenchLitePatch,
    };
    const args = dockerSwebenchRunArgs(
      input,
      predictionPath,
      descriptor,
      "agentoj-swebench-lite",
      "__AGENTOJ_HIDDEN_ORACLE_STARTED__:unit",
    );
    const joined = JSON.stringify(args);
    assert.deepEqual(args, ["image", "inspect", SWEBENCH_LITE_HARNESS_IMAGE_DIGEST]);
    assert.deepEqual(dockerSwebenchPullArgs(input), ["pull", SWEBENCH_LITE_HARNESS_IMAGE_DIGEST]);
    assert.equal(joined.includes("SWE-bench Lite candidate patch"), false);
    assert.equal(joined.includes("original-harness-log"), false);
    assert.equal(joined.includes("rerun-harness-log"), false);
    const harnessArgs = swebenchHostHarnessRunArgs("run-swebench-pinned.py", predictionPath, descriptor, "unit-run");
    assert.deepEqual(harnessArgs, ["run-swebench-pinned.py", SWEBENCH_LITE_DATASET_NAME, "test", predictionPath, descriptor.instanceId, "unit-run"]);
    assert.equal(JSON.stringify(harnessArgs).includes("SWE-bench Lite candidate patch"), false);
  });

  it("requires official SWE-bench report resolution and hash-bound prediction evidence", () => {
    const problem = getSwebenchLiteProblem("swe-bench-lite-astropy-12907");
    assert.ok(problem);
    const descriptor = JSON.parse(officialSwebenchLiteDescriptor(problem)) as {
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
      evidencePolicy: { originalEvidenceId: string; rerunEvidenceId: string };
    };
    const input = {
      benchmark: SWEBENCH_LITE_BENCHMARK,
      adapter: SWEBENCH_LITE_ADAPTER,
      problem,
      submission: createPatchSubmission(problem, "swebench-lite-report-evidence"),
      patch: swebenchLitePatch,
    };
    const predictionJsonl = JSON.stringify({ instance_id: descriptor.instanceId, model_name_or_path: "open-agent-judge-pr", model_patch: swebenchLitePatch }) + "\n";
    const predictionEvidence = validateSwebenchPredictionJsonl(predictionJsonl, input, descriptor);
    assert.match(predictionEvidence.predictionJsonlHash, /^sha256:[0-9a-f]{64}$/);
    const report = JSON.stringify({
      schema_version: 2,
      submitted_ids: [descriptor.instanceId],
      completed_ids: [descriptor.instanceId],
      resolved_ids: [descriptor.instanceId],
      unresolved_ids: [],
      error_ids: [],
    });
    const evidence = JSON.parse(swebenchResolvedEvidenceFromReport(report, descriptor, predictionEvidence)) as Record<string, unknown>;
    assert.equal(evidence.resolved, true);
    assert.equal(evidence.instanceId, descriptor.instanceId);
    assert.equal(evidence.predictionJsonlSchemaHash, SWEBENCH_LITE_PREDICTION_JSONL_SCHEMA_HASH);
    assert.throws(
      () =>
        swebenchResolvedEvidenceFromReport(
          JSON.stringify({ schema_version: 2, submitted_ids: [descriptor.instanceId], completed_ids: [descriptor.instanceId], resolved_ids: [], unresolved_ids: [descriptor.instanceId], error_ids: [] }),
          descriptor,
          predictionEvidence,
        ),
      /SWE-bench report unresolved/,
    );
  });

  it("rejects SWE-bench Lite PR judging unless maintainer workflow dispatch metadata is present", () => {
    const problem = getSwebenchLiteProblem("swe-bench-lite-astropy-12907");
    assert.ok(problem);
    const dir = mkdtempSync(join(tmpdir(), "agentoj-swebench-pr-"));
    const patchPath = join(dir, "submission.patch");
    const submissionPath = join(dir, "submission.json");
    const summaryOut = join(dir, "summary.json");
    writeFileSync(patchPath, swebenchLitePatch, "utf8");
    const envelope = {
      id: "swebench-lite-pr",
      schemaVersion: 1,
      problemId: problem.id,
      adapterId: problem.adapterId,
      prHeadSha: "0123456789abcdef0123456789abcdef01234567",
      patchSha256: `sha256:${sha256(swebenchLitePatch)}`,
      patchBytes: Buffer.byteLength(swebenchLitePatch),
      patchStats: { filesChanged: 1, locAdded: 1, locDeleted: 1 },
      files: [{ path: "astropy/modeling/separable.py", changeType: "modify", gitMode: "100644", byteSize: 512, isBinary: false, isSymlink: false }],
      publicSubmission: true,
    };
    writeFileSync(submissionPath, JSON.stringify(envelope), "utf8");
    const previousDescriptor = process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON;
    process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON = officialSwebenchLiteDescriptor(problem);
    try {
      const pullRequest = runCli([
        "judge-pr-submission",
        "--submission",
        submissionPath,
        "--patch",
        patchPath,
        "--summary-out",
        summaryOut,
        "--expected-pr-head-sha",
        envelope.prHeadSha,
        "--sandbox",
        "docker",
      ]);
      assert.equal(pullRequest.ok, false);
      assert.match((pullRequest.issues ?? []).join("\n"), /benchmarkPolicy\.trigger\.maintainerRequired/);

      const missingInstance = runCli([
        "judge-pr-submission",
        "--submission",
        submissionPath,
        "--patch",
        patchPath,
        "--summary-out",
        summaryOut,
        "--expected-pr-head-sha",
        envelope.prHeadSha,
        "--trigger",
        "workflow_dispatch",
        "--sandbox",
        "docker",
      ]);
      assert.equal(missingInstance.ok, false);
      assert.match((missingInstance.issues ?? []).join("\n"), /benchmarkPolicy\.instance\.required/);

      const nonAllowlistedInstance = runCli([
        "judge-pr-submission",
        "--submission",
        submissionPath,
        "--patch",
        patchPath,
        "--summary-out",
        summaryOut,
        "--expected-pr-head-sha",
        envelope.prHeadSha,
        "--trigger",
        "workflow_dispatch",
        "--instance-id",
        "astropy__astropy-99999",
        "--sandbox",
        "docker",
      ]);
      assert.equal(nonAllowlistedInstance.ok, false);
      assert.match((nonAllowlistedInstance.issues ?? []).join("\n"), /benchmarkPolicy\.instance\.allowlist|benchmarkPolicy\.instance\.descriptorMismatch/);

      const maintainerRun = runCli([
        "judge-pr-submission",
        "--submission",
        submissionPath,
        "--patch",
        patchPath,
        "--summary-out",
        summaryOut,
        "--expected-pr-head-sha",
        envelope.prHeadSha,
        "--trigger",
        "workflow_dispatch",
        "--instance-id",
        "astropy__astropy-12907",
        "--sandbox",
        "docker",
      ]);
      assert.equal(maintainerRun.ok, false);
      assert.doesNotMatch((maintainerRun.issues ?? []).join("\n"), /benchmarkPolicy\.trigger\.maintainerRequired/);
      assert.equal(maintainerRun.sandboxMode, "docker");
      assert.match(maintainerRun.error ?? "", /PR judge did not pass|Docker unavailable|SWE-bench upstream harness failed|Verification failed/);
    } finally {
      if (previousDescriptor === undefined) {
        delete process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON;
      } else {
        process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON = previousDescriptor;
      }
    }
  });
  it("scores an allowlisted SWE-bench Lite maintainer dispatch through a verified pinned harness path", () => {
    const problem = getSwebenchLiteProblem("swe-bench-lite-astropy-12907");
    assert.ok(problem);
    const dir = mkdtempSync(join(tmpdir(), "agentoj-swebench-pr-pass-"));
    const binDir = join(dir, "bin");
    const harnessDir = join(dir, "swe-bench");
    mkdirSync(binDir);
    mkdirSync(harnessDir);
    const dockerPath = join(binDir, "docker");
    writeFileSync(
      dockerPath,
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then echo 'Docker version 25.0.0'; exit 0; fi",
        "if [ \"$1\" = \"pull\" ]; then echo \"pulled $2\"; exit 0; fi",
        "if [ \"$1\" = \"image\" ] && [ \"$2\" = \"inspect\" ]; then echo '[{\"RepoDigests\":[\"'$3'\"]}]'; exit 0; fi",
        "echo unexpected docker args >&2",
        "exit 2",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(dockerPath, 0o755);
    const gitPath = join(binDir, "git");
    writeFileSync(
      gitPath,
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"-C\" ] && [ \"$3\" = \"rev-parse\" ] && [ \"$4\" = \"HEAD\" ]; then echo '" + SWEBENCH_LITE_HARNESS_COMMIT + "'; exit 0; fi",
        "echo unexpected git args >&2",
        "exit 2",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(gitPath, 0o755);
    const pythonPath = join(binDir, "python3");
    writeFileSync(
      pythonPath,
      [
        "#!/bin/sh",
        "cat > \"open-agent-judge-pr.$6.json\" <<EOF",
        "{\"schema_version\":2,\"submitted_ids\":[\"$5\"],\"completed_ids\":[\"$5\"],\"resolved_ids\":[\"$5\"],\"unresolved_ids\":[],\"error_ids\":[]}",
        "EOF",
        "exit 0",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(pythonPath, 0o755);

    const patchPath = join(dir, "submission.patch");
    const submissionPath = join(dir, "submission.json");
    const summaryOut = join(dir, "summary.json");
    writeFileSync(patchPath, swebenchLitePatch, "utf8");
    const envelope = {
      id: "swebench-lite-pr-pass",
      schemaVersion: 1,
      problemId: problem.id,
      adapterId: problem.adapterId,
      prHeadSha: "1123456789abcdef0123456789abcdef01234567",
      patchSha256: `sha256:${sha256(swebenchLitePatch)}`,
      patchBytes: Buffer.byteLength(swebenchLitePatch),
      patchStats: { filesChanged: 1, locAdded: 1, locDeleted: 1 },
      files: [{ path: "astropy/modeling/separable.py", changeType: "modify", gitMode: "100644", byteSize: 512, isBinary: false, isSymlink: false }],
      publicSubmission: true,
    };
    writeFileSync(submissionPath, JSON.stringify(envelope), "utf8");

    const previousDescriptor = process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON;
    const previousHarnessPath = process.env.AGENTOJ_SWEBENCH_HARNESS_PATH;
    const previousPath = process.env.PATH;
    process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON = officialSwebenchLiteDescriptor(problem);
    process.env.AGENTOJ_SWEBENCH_HARNESS_PATH = harnessDir;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    try {
      const maintainerRun = runCli([
        "judge-pr-submission",
        "--submission",
        submissionPath,
        "--patch",
        patchPath,
        "--summary-out",
        summaryOut,
        "--expected-pr-head-sha",
        envelope.prHeadSha,
        "--trigger",
        "workflow_dispatch",
        "--instance-id",
        "astropy__astropy-12907",
        "--sandbox",
        "docker",
      ]);
      assert.equal(maintainerRun.ok, true);
      assert.equal(maintainerRun.runnerStatus, "passed");
      assert.equal(maintainerRun.sandboxMode, "docker");
      assert.equal(maintainerRun.oracleMode, "hidden-oracle-scored");
      assert.equal(maintainerRun.judgeSummary.status, "passed");
      assert.equal(
        maintainerRun.judgeSummary.validationMessages.some((message: string) => message.includes("oracle.scored")),
        true,
      );
    } finally {
      if (previousDescriptor === undefined) {
        delete process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON;
      } else {
        process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON = previousDescriptor;
      }
      if (previousHarnessPath === undefined) {
        delete process.env.AGENTOJ_SWEBENCH_HARNESS_PATH;
      } else {
        process.env.AGENTOJ_SWEBENCH_HARNESS_PATH = previousHarnessPath;
      }
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
  });
});
describe("SWE-bench Verified official harness scored surface", () => {
  it("pins a real Verified official-harness instance with a descriptor distinct from Lite", () => {
    assert.doesNotThrow(() => validateSwebenchVerifiedAdapterSeed());
    assert.equal(SWEBENCH_VERIFIED_BENCHMARK.id, "swe-bench-verified");
    assert.equal(SWEBENCH_VERIFIED_BENCHMARK.upstreamCommitOrVersion, SWEBENCH_VERIFIED_HARNESS_COMMIT);
    assert.equal(SWEBENCH_VERIFIED_DATASET_NAME, "princeton-nlp/SWE-bench_Verified");
    assert.equal(SWEBENCH_VERIFIED_DATASET_REVISION, "c104f840cc67f8b6eec6f759ebc8b2693d585d4a");
    assert.equal(SWEBENCH_VERIFIED_HARNESS_COMMIT, SWEBENCH_LITE_HARNESS_COMMIT);
    assert.equal(SWEBENCH_VERIFIED_HARNESS_IMAGE_DIGEST, SWEBENCH_LITE_HARNESS_IMAGE_DIGEST);
    assert.equal(SWEBENCH_VERIFIED_PREDICTION_JSONL_SCHEMA_HASH, SWEBENCH_LITE_PREDICTION_JSONL_SCHEMA_HASH);
    assert.equal(SWEBENCH_VERIFIED_PROBLEMS.length, 1);
    const problem = getSwebenchVerifiedProblem("swe-bench-verified-astropy-12907");
    assert.ok(problem);
    assert.equal(problem.benchmarkId, "swe-bench-verified");
    assert.equal(problem.adapterId, "swebench-verified");
    assert.equal(problem.upstreamTaskId, "astropy__astropy-12907");
    assert.equal(problem.oracleMetadata?.oracleDescriptorHash, `sha256:${sha256(officialSwebenchVerifiedDescriptor(problem))}`);
    const liteProblem = getSwebenchLiteProblem("swe-bench-lite-astropy-12907");
    assert.ok(liteProblem);
    assert.notEqual(problem.id, liteProblem.id);
    assert.notEqual(problem.benchmarkId, liteProblem.benchmarkId);
    assert.notEqual(problem.oracleMetadata?.oracleDescriptorHash, liteProblem.oracleMetadata?.oracleDescriptorHash);
  });

  it("validates Verified descriptors and rejects Lite evidence as insufficient", () => {
    const verified = getSwebenchVerifiedProblem("swe-bench-verified-astropy-12907");
    const lite = getSwebenchLiteProblem("swe-bench-lite-astropy-12907");
    assert.ok(verified);
    assert.ok(lite);
    const selected = selectCanonicalPrivateOracleDescriptor(
      {
        ...verified,
        oracleMetadata: {
          kind: "generated-private",
          hiddenRequired: true,
          oracleDescriptorHash: verified.oracleMetadata?.oracleDescriptorHash,
        },
      },
      JSON.parse(officialSwebenchVerifiedDescriptor(verified)) as unknown,
    );
    assert.ok(selected);
    assert.equal(`sha256:${sha256(selected.canonicalJson)}`, verified.oracleMetadata?.oracleDescriptorHash);
    assert.equal(selected.descriptor.descriptorRevision, SWEBENCH_VERIFIED_DESCRIPTOR_REVISION);
    const liteSelected = selectCanonicalPrivateOracleDescriptor(verified, JSON.parse(officialSwebenchLiteDescriptor(lite)) as unknown);
    assert.equal(liteSelected, null);
  });

  it("scores an allowlisted SWE-bench Verified maintainer dispatch through a verified pinned harness path", () => {
    const problem = getSwebenchVerifiedProblem("swe-bench-verified-astropy-12907");
    assert.ok(problem);
    const dir = mkdtempSync(join(tmpdir(), "agentoj-swebench-verified-pr-pass-"));
    const binDir = join(dir, "bin");
    const harnessDir = join(dir, "swe-bench");
    mkdirSync(binDir);
    mkdirSync(harnessDir);
    const dockerPath = join(binDir, "docker");
    writeFileSync(
      dockerPath,
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then echo 'Docker version 25.0.0'; exit 0; fi",
        "if [ \"$1\" = \"pull\" ]; then echo \"pulled $2\"; exit 0; fi",
        "if [ \"$1\" = \"image\" ] && [ \"$2\" = \"inspect\" ]; then echo '[{\"RepoDigests\":[\"'$3'\"]}]'; exit 0; fi",
        "echo unexpected docker args >&2",
        "exit 2",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(dockerPath, 0o755);
    const gitPath = join(binDir, "git");
    writeFileSync(
      gitPath,
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"-C\" ] && [ \"$3\" = \"rev-parse\" ] && [ \"$4\" = \"HEAD\" ]; then echo '" + SWEBENCH_VERIFIED_HARNESS_COMMIT + "'; exit 0; fi",
        "echo unexpected git args >&2",
        "exit 2",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(gitPath, 0o755);
    const pythonPath = join(binDir, "python3");
    writeFileSync(
      pythonPath,
      [
        "#!/bin/sh",
        "cat > \"open-agent-judge-pr.$6.json\" <<EOF",
        "{\"schema_version\":2,\"submitted_ids\":[\"$5\"],\"completed_ids\":[\"$5\"],\"resolved_ids\":[\"$5\"],\"unresolved_ids\":[],\"error_ids\":[]}",
        "EOF",
        "exit 0",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(pythonPath, 0o755);

    const patchPath = join(dir, "submission.patch");
    const submissionPath = join(dir, "submission.json");
    const summaryOut = join(dir, "summary.json");
    writeFileSync(patchPath, swebenchLitePatch, "utf8");
    const envelope = {
      id: "swebench-verified-pr-pass",
      schemaVersion: 1,
      problemId: problem.id,
      adapterId: problem.adapterId,
      prHeadSha: "2123456789abcdef0123456789abcdef01234567",
      patchSha256: `sha256:${sha256(swebenchLitePatch)}`,
      patchBytes: Buffer.byteLength(swebenchLitePatch),
      patchStats: { filesChanged: 1, locAdded: 1, locDeleted: 1 },
      files: [{ path: "astropy/modeling/separable.py", changeType: "modify", gitMode: "100644", byteSize: 512, isBinary: false, isSymlink: false }],
      publicSubmission: true,
    };
    writeFileSync(submissionPath, JSON.stringify(envelope), "utf8");

    const previousDescriptor = process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON;
    const previousHarnessPath = process.env.AGENTOJ_SWEBENCH_HARNESS_PATH;
    const previousPath = process.env.PATH;
    process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON = officialSwebenchVerifiedDescriptor(problem);
    process.env.AGENTOJ_SWEBENCH_HARNESS_PATH = harnessDir;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    try {
      const maintainerRun = runCli([
        "judge-pr-submission",
        "--submission",
        submissionPath,
        "--patch",
        patchPath,
        "--summary-out",
        summaryOut,
        "--expected-pr-head-sha",
        envelope.prHeadSha,
        "--trigger",
        "workflow_dispatch",
        "--instance-id",
        "astropy__astropy-12907",
        "--sandbox",
        "docker",
      ]);
      assert.equal(maintainerRun.ok, true);
      assert.equal(maintainerRun.problemId, problem.id);
      assert.equal(maintainerRun.runnerStatus, "passed");
      assert.equal(maintainerRun.sandboxMode, "docker");
      assert.equal(maintainerRun.oracleMode, "hidden-oracle-scored");
      assert.equal(maintainerRun.judgeSummary.status, "passed");
    } finally {
      if (previousDescriptor === undefined) {
        delete process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON;
      } else {
        process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON = previousDescriptor;
      }
      if (previousHarnessPath === undefined) {
        delete process.env.AGENTOJ_SWEBENCH_HARNESS_PATH;
      } else {
        process.env.AGENTOJ_SWEBENCH_HARNESS_PATH = previousHarnessPath;
      }
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
  });
});
describe("local patch runner", () => {
  it("applies a unified diff to the fixture and runs the adapter command", () => {
    const problem = getHumanEvalProblem("humaneval-001");
    assert.ok(problem);
    const submission = createPatchSubmission(problem, "local-runner-pass");

    const verification = runLocalPatchVerification({
      benchmark: HUMANEVAL_BENCHMARK,
      adapter: HUMANEVAL_ADAPTER,
      problem,
      submission,
      patch: passingPatch,
    });

    assert.equal(verification.job.status, "passed");
    assert.equal(verification.result.patchApplyStatus, "clean");
    assert.equal(verification.result.passFail, "pass");
    assert.equal(verification.result.exitCode, 0);
    assert.match(verification.stderr, /OK/);
  });

  it("fails closed when patch context does not match the fixture", () => {
    const problem = getHumanEvalProblem("humaneval-001");
    assert.ok(problem);
    const submission = createPatchSubmission(problem, "local-runner-fail");
    const badPatch = passingPatch.replace("    return None", "    return missing");

    const verification = runLocalPatchVerification({
      benchmark: HUMANEVAL_BENCHMARK,
      adapter: HUMANEVAL_ADAPTER,
      problem,
      submission,
      patch: badPatch,
    });

    assert.equal(verification.job.status, "failed");
    assert.equal(verification.result.patchApplyStatus, "failed");
    assert.equal(verification.result.passFail, "fail");
    assert.match(verification.stderr, /Patch delete mismatch/);
  });

  it("reports timed-out runner status when the judge command exceeds its timeout", () => {
    const problem = getHumanEvalProblem("humaneval-001");
    assert.ok(problem);
    const submission = createPatchSubmission(problem, "local-runner-timeout");
    const slowAdapter = {
      ...HUMANEVAL_ADAPTER,
      judgeCommand: [process.execPath, "-e", "setTimeout(() => {}, 1000)"],
      defaultResources: { ...HUMANEVAL_ADAPTER.defaultResources, timeoutSeconds: 0.001 },
    };

    const verification = runLocalPatchVerification({
      benchmark: HUMANEVAL_BENCHMARK,
      adapter: slowAdapter,
      problem,
      submission,
      patch: passingPatch,
    });

    assert.equal(verification.job.status, "timed-out");
    assert.equal(verification.result.passFail, "fail");
  });
  it("rejects unified diff targets outside the fixture worktree", () => {
    const problem = getHumanEvalProblem("humaneval-001");
    assert.ok(problem);
    const submission = createPatchSubmission(problem, "local-runner-traversal");
    const traversalPatch = [
      "diff --git a/../../outside.txt b/../../outside.txt",
      "--- a/../../outside.txt",
      "+++ b/../../outside.txt",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");

    const verification = runLocalPatchVerification({
      benchmark: HUMANEVAL_BENCHMARK,
      adapter: HUMANEVAL_ADAPTER,
      problem,
      submission,
      patch: traversalPatch,
    });

    assert.equal(verification.job.status, "failed");
    assert.equal(verification.result.patchApplyStatus, "failed");
    assert.match(verification.stderr, /not canonical/);
  });
  it("rejects patches that modify judge assets instead of editable solution files", () => {
    const problem = getHumanEvalProblem("humaneval-001");
    assert.ok(problem);
    const submission = createPatchSubmission(problem, "local-runner-judge-asset");

    const verification = runLocalPatchVerification({
      benchmark: HUMANEVAL_BENCHMARK,
      adapter: HUMANEVAL_ADAPTER,
      problem,
      submission,
      patch: judgeAssetPatch,
    });

    assert.equal(verification.job.status, "failed");
    assert.equal(verification.result.patchApplyStatus, "failed");
    assert.match(verification.stderr, /patch\.target\.notEditable|not editable/);
  });
  it("keeps public fixture verification demo-only and fails closed without a private oracle descriptor", () => {
    const problem = getHumanEvalProblem("humaneval-001");
    assert.ok(problem);

    const publicDemo = runLocalPatchVerification({
      benchmark: HUMANEVAL_BENCHMARK,
      adapter: HUMANEVAL_ADAPTER,
      problem,
      submission: createPatchSubmission(problem, "public-overfit-demo"),
      patch: publicOverfitPatch,
    });
    assert.equal(publicDemo.result.passFail, "pass");
    assert.equal(publicDemo.job.scoringStatus, "demo");

    const hidden = runHiddenOraclePatchVerification({
      benchmark: HUMANEVAL_BENCHMARK,
      adapter: HUMANEVAL_ADAPTER,
      problem,
      submission: createPatchSubmission(problem, "hidden-private-oracle-required"),
      patch: passingPatch,
    });
    assert.equal(hidden.result.passFail, "fail");
    assert.equal(hidden.job.status, "failed");
    assert.match(hidden.stderr, /local hidden-oracle execution is disabled|private oracle metadata|private oracle descriptor/i);
  });
  it("runs versioned python-function-cases private descriptors and rejects unsupported kinds fail-closed", () => {
    const problem = getHumanEvalProblem("humaneval-001");
    assert.ok(problem);

    const passed = withVersionedPrivateOracle(
      problem,
      [{ id: "versioned-first", args: [[9, 8, 7]], expected: 9 }],
      (scoredProblem) =>
        runHiddenOraclePatchVerification({
          benchmark: HUMANEVAL_BENCHMARK,
          adapter: HUMANEVAL_ADAPTER,
          problem: scoredProblem,
          submission: createPatchSubmission(scoredProblem, "versioned-hidden-pass"),
          patch: alternateEntryPointPatch,
        }),
      "solve",
    );

    assert.equal(passed.result.passFail, "pass");
    assert.equal(passed.job.scoringStatus, "scored");
    assert.equal(passed.stdout, "");

    const unsupportedDescriptor = JSON.stringify({
      schemaVersion: 2,
      problemId: problem.id,
      benchmarkId: problem.benchmarkId,
      adapterId: problem.adapterId,
      upstreamTaskId: problem.upstreamTaskId,
      oracleKind: "command-hidden-tests",
      commandId: "pytest-hidden",
      allowedTargets: ["solution.py"],
      hiddenTestBundleHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      expectedExitCode: 0,
      evidencePolicy: { originalEvidenceId: "original-command", rerunEvidenceId: "rerun-command" },
      fixtureHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    const previousJson = process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON;
    const previousUnsafeLocal = process.env.AGENTOJ_ALLOW_UNSAFE_LOCAL_HIDDEN_ORACLE;
    process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON = unsupportedDescriptor;
    process.env.AGENTOJ_ALLOW_UNSAFE_LOCAL_HIDDEN_ORACLE = "1";
    try {
      const unsupportedProblem: Problem = {
        ...problem,
        scoringMode: "scored-hidden",
        oracleMetadata: {
          kind: "generated-private",
          hiddenRequired: true,
          oracleDescriptorHash: `sha256:${sha256(unsupportedDescriptor)}`,
          originalEvidenceId: "original-command",
          rerunEvidenceId: "rerun-command",
        },
      };
      const failed = runHiddenOraclePatchVerification({
        benchmark: HUMANEVAL_BENCHMARK,
        adapter: HUMANEVAL_ADAPTER,
        problem: unsupportedProblem,
        submission: createPatchSubmission(unsupportedProblem, "versioned-hidden-unsupported"),
        patch: passingPatch,
      });
      assert.equal(failed.result.passFail, "fail");
      assert.match(failed.stderr, /unsupportedKind|invalidShape|supported hidden oracle payload|official test-source descriptors/);
    } finally {
      if (previousJson === undefined) {
        delete process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON;
      } else {
        process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON = previousJson;
      }
      if (previousUnsafeLocal === undefined) {
        delete process.env.AGENTOJ_ALLOW_UNSAFE_LOCAL_HIDDEN_ORACLE;
      } else {
        process.env.AGENTOJ_ALLOW_UNSAFE_LOCAL_HIDDEN_ORACLE = previousUnsafeLocal;
      }
    }
  });
  it("runs official HumanEval test-source descriptors through the fixed private oracle path", async () => {
    const problem = getHumanEvalProblem("humaneval-full-000");
    assert.ok(problem);
    const [task] = await fetchPinnedHumanEvalTasks();
    const descriptor = officialHumanEvalDescriptor(problem, task);
    const runtimeProblem: Problem = {
      ...problem,
      oracleMetadata: { ...problem.oracleMetadata!, oracleDescriptorHash: `sha256:${sha256(descriptor)}` },
    };

    const previousJson = process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON;
    const previousUnsafeLocal = process.env.AGENTOJ_ALLOW_UNSAFE_LOCAL_HIDDEN_ORACLE;
    process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON = descriptor;
    process.env.AGENTOJ_ALLOW_UNSAFE_LOCAL_HIDDEN_ORACLE = "1";
    try {
      const patch = [
        "diff --git a/solution.py b/solution.py",
        "--- a/solution.py",
        "+++ b/solution.py",
        "@@ -0,0 +1,6 @@",
        "+def has_close_elements(numbers, threshold):",
        "+    for i, left in enumerate(numbers):",
        "+        for right in numbers[i + 1:]:",
        "+            if abs(left - right) < threshold:",
        "+                return True",
        "+    return False",
        "",
      ].join("\n");
      const fixtureDir = mkdtempSync(join(tmpdir(), "agentoj-empty-fixture-"));
      writeFileSync(join(fixtureDir, "solution.py"), "", "utf8");
      const dockerArgs = dockerRunArgs(
        {
          benchmark: HUMANEVAL_BENCHMARK,
          adapter: HUMANEVAL_ADAPTER,
          problem: runtimeProblem,
          submission: createPatchSubmission(runtimeProblem, "official-hidden-docker-args"),
          patch,
        },
        fixtureDir,
      );
      assert.ok(dockerArgs.includes("PYTHONPATH=/solution"));
      assert.ok(dockerArgs.includes(HUMANEVAL_ADAPTER.dockerImageDigest));
      assert.equal(dockerArgs.some((arg) => arg.includes("assert candidate")), false);
      assert.equal(dockerArgs.some((arg) => arg.includes("/work/tests")), false);
      const dockerArgvJson = JSON.stringify(dockerArgs);
      assert.equal(dockerArgvJson.includes(descriptor), false);
      assert.equal(dockerArgvJson.includes(task.test), false);
      assert.equal(dockerArgvJson.includes("testSource"), false);
      assert.equal(dockerArgvJson.includes("cases"), false);
      assert.equal(dockerArgvJson.includes(officialHumanEvalEvidencePolicy(problem.id).originalEvidenceId), false);
      assert.equal(dockerArgvJson.includes(officialHumanEvalEvidencePolicy(problem.id).rerunEvidenceId), false);
      assert.equal(dockerArgvJson.includes("AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR"), false);

      const passed = runHiddenOraclePatchVerification({
        benchmark: HUMANEVAL_BENCHMARK,
        adapter: HUMANEVAL_ADAPTER,
        problem: runtimeProblem,
        submission: createPatchSubmission(runtimeProblem, "official-hidden-pass"),
        patch,
        fixtureDir,
      });
      assert.equal(passed.result.passFail, "pass");
      assert.equal(passed.job.scoringStatus, "scored");
      assert.equal(passed.stdout, "");

      const preExecutionFailure = runHiddenOraclePatchVerification({
        benchmark: HUMANEVAL_BENCHMARK,
        adapter: HUMANEVAL_ADAPTER,
        problem: runtimeProblem,
        submission: createPatchSubmission(runtimeProblem, "official-hidden-pre-exec-fail"),
        patch: passingPatch,
        fixtureDir,
      });
      assert.equal(preExecutionFailure.result.patchApplyStatus, "failed");
      assert.equal(preExecutionFailure.job.scoringStatus, "demo");
      assert.equal(preExecutionFailure.job.oracleDescriptorHash, null);

      const publicKindProblem: Problem = {
        ...runtimeProblem,
        oracleMetadata: { ...runtimeProblem.oracleMetadata!, kind: "public-fixture" as "hidden-fixture" },
      };
      const publicKindFailure = runHiddenOraclePatchVerification({
        benchmark: HUMANEVAL_BENCHMARK,
        adapter: HUMANEVAL_ADAPTER,
        problem: publicKindProblem,
        submission: createPatchSubmission(publicKindProblem, "official-hidden-public-kind-fail"),
        patch,
        fixtureDir,
      });
      assert.equal(publicKindFailure.result.passFail, "fail");
      assert.equal(publicKindFailure.job.scoringStatus, "demo");
      assert.equal(publicKindFailure.job.oracleDescriptorHash, null);
      assert.match(publicKindFailure.stderr, /private oracle metadata missing/i);

      const failed = runHiddenOraclePatchVerification({
        benchmark: HUMANEVAL_BENCHMARK,
        adapter: HUMANEVAL_ADAPTER,
        problem: runtimeProblem,
        submission: createPatchSubmission(runtimeProblem, "official-hidden-fail"),
        patch: patch.replace("+                return True", "+                return False"),
        fixtureDir,
      });
      assert.equal(failed.result.passFail, "fail");
      assert.equal(failed.stdout, "");
      assert.equal(failed.stderr, "official hidden oracle failed");
      const introspectionPatch = [
        "diff --git a/solution.py b/solution.py",
        "--- a/solution.py",
        "+++ b/solution.py",
        "@@ -0,0 +1,13 @@",
        "+import inspect",
        "+frame = inspect.currentframe()",
        "+while frame is not None:",
        "+    locals_text = repr(frame.f_locals)",
        "+    if 'def check(candidate)' in locals_text:",
        "+        raise RuntimeError('hidden oracle leaked into candidate import frame')",
        "+    frame = frame.f_back",
        "+def has_close_elements(numbers, threshold):",
        "+    for i, left in enumerate(numbers):",
        "+        for right in numbers[i + 1:]:",
        "+            if abs(left - right) < threshold:",
        "+                return True",
        "+    return False",
        "",
      ].join("\n");
      const introspectionPassed = runHiddenOraclePatchVerification({
        benchmark: HUMANEVAL_BENCHMARK,
        adapter: HUMANEVAL_ADAPTER,
        problem: runtimeProblem,
        submission: createPatchSubmission(runtimeProblem, "official-hidden-import-frame-isolated"),
        patch: introspectionPatch,
        fixtureDir,
      });
      assert.equal(introspectionPassed.result.passFail, "pass");
      assert.equal(introspectionPassed.job.scoringStatus, "scored");
    } finally {
      if (previousJson === undefined) {
        delete process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON;
      } else {
        process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON = previousJson;
      }
      if (previousUnsafeLocal === undefined) {
        delete process.env.AGENTOJ_ALLOW_UNSAFE_LOCAL_HIDDEN_ORACLE;
      } else {
        process.env.AGENTOJ_ALLOW_UNSAFE_LOCAL_HIDDEN_ORACLE = previousUnsafeLocal;
      }
    }
  });
  it("runs real MBPP subset python-function-cases descriptors and keeps synthetic seed ids demo-only", async () => {
    const problem = getMbppProblem("mbpp-full-003");
    assert.ok(problem);
    const task = (await fetchPinnedMbppTasks()).find((candidate) => candidate.task_id === 3);
    assert.ok(task);
    const cases = extractMbppCasesWithPython(task, "is_not_prime");
    const descriptor = officialMbppDescriptor(problem, "is_not_prime", cases);
    const descriptorHash = `sha256:${sha256(descriptor)}`;
    assert.equal(problem.oracleMetadata?.oracleDescriptorHash, descriptorHash);
    const runtimeProblem = problem;
    const patch = [
      "diff --git a/solution.py b/solution.py",
      "--- a/solution.py",
      "+++ b/solution.py",
      "@@ -0,0 +1,7 @@",
      "+def is_not_prime(n):",
      "+    if n < 2:",
      "+        return True",
      "+    for value in range(2, int(n ** 0.5) + 1):",
      "+        if n % value == 0:",
      "+            return True",
      "+    return False",
      "",
    ].join("\n");
    const failingPatch = [
      "diff --git a/solution.py b/solution.py",
      "--- a/solution.py",
      "+++ b/solution.py",
      "@@ -0,0 +1,2 @@",
      "+def is_not_prime(n):",
      "+    return False",
      "",
    ].join("\n");

    const previousJson = process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON;
    const previousUnsafeLocal = process.env.AGENTOJ_ALLOW_UNSAFE_LOCAL_HIDDEN_ORACLE;
    process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON = descriptor;
    process.env.AGENTOJ_ALLOW_UNSAFE_LOCAL_HIDDEN_ORACLE = "1";
    try {
      const fixtureDir = mkdtempSync(join(tmpdir(), "agentoj-mbpp-hidden-fixture-"));
      writeFileSync(join(fixtureDir, "solution.py"), "", "utf8");
      const dockerArgs = dockerRunArgs(
        {
          benchmark: MBPP_BENCHMARK,
          adapter: MBPP_ADAPTER,
          problem: runtimeProblem,
          submission: createPatchSubmission(runtimeProblem, "mbpp-subset-hidden-docker-args"),
          patch,
        },
        fixtureDir,
      );
      const dockerArgvJson = JSON.stringify(dockerArgs);
      assert.ok(dockerArgs.includes(MBPP_ADAPTER.dockerImageDigest));
      assert.ok(dockerArgs.includes("PYTHONPATH=/solution"));
      assert.equal(dockerArgvJson.includes(descriptor), false);
      assert.equal(dockerArgvJson.includes("mbpp-3-case-1"), false);
      assert.equal(dockerArgvJson.includes("private-original-evidence"), false);
      assert.equal(dockerArgvJson.includes("AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR"), false);

      const passed = runHiddenOraclePatchVerification({
        benchmark: MBPP_BENCHMARK,
        adapter: MBPP_ADAPTER,
        problem: runtimeProblem,
        submission: createPatchSubmission(runtimeProblem, "mbpp-subset-hidden-pass"),
        patch,
        fixtureDir,
      });
      assert.equal(passed.result.passFail, "pass");
      assert.equal(passed.job.scoringStatus, "scored");
      assert.equal(passed.job.oracleDescriptorHash, runtimeProblem.oracleMetadata?.oracleDescriptorHash);
      assert.equal(passed.stdout, "");

      const failed = runHiddenOraclePatchVerification({
        benchmark: MBPP_BENCHMARK,
        adapter: MBPP_ADAPTER,
        problem: runtimeProblem,
        submission: createPatchSubmission(runtimeProblem, "mbpp-subset-hidden-fail"),
        patch: failingPatch,
        fixtureDir,
      });
      assert.equal(failed.result.passFail, "fail");
      assert.equal(failed.job.scoringStatus, "scored");
      assert.equal(failed.job.oracleDescriptorHash, runtimeProblem.oracleMetadata?.oracleDescriptorHash);
      assert.equal(failed.stdout, "");

      const syntheticSeed = getMbppProblem("mbpp-001-adapter-only");
      assert.ok(syntheticSeed);
      assert.equal(syntheticSeed.scoringMode, undefined);
      const syntheticRun = runLocalPatchVerification({
        benchmark: MBPP_BENCHMARK,
        adapter: MBPP_ADAPTER,
        problem: syntheticSeed,
        submission: createPatchSubmission(syntheticSeed, "mbpp-synthetic-demo-only"),
        patch: mbppReversePatch,
      });
      assert.equal(syntheticRun.result.passFail, "pass");
      assert.equal(syntheticRun.job.scoringStatus, "demo");
      assert.equal(syntheticRun.job.oracleDescriptorHash, null);

      const dir = mkdtempSync(join(tmpdir(), "agentoj-mbpp-synthetic-pr-"));
      const patchPath = join(dir, "fix.diff");
      const submissionPath = join(dir, "submission.json");
      const summaryPath = join(dir, "summary.json");
      writeFileSync(patchPath, mbppReversePatch, "utf8");
      writeFileSync(submissionPath, JSON.stringify(prSubmissionEnvelope("mbpp-001-adapter-only", "mbpp-python", mbppReversePatch)), "utf8");
      const syntheticPr = runCli(["judge-pr-submission", "--submission", submissionPath, "--patch", patchPath, "--summary-out", summaryPath]);
      const syntheticSummary = JSON.parse(readFileSync(summaryPath, "utf8")) as { status: string; validationMessages: string[] };
      assert.equal(syntheticPr.ok, false);
      assert.equal(syntheticPr.runnerStatus, "invalid");
      assert.match(syntheticSummary.validationMessages.join("\n"), /scoredHiddenRequired/);
      assert.equal(JSON.stringify(syntheticSummary).includes("reverse_string"), false);
      assert.equal(validateSanitizedPrJudgeSummary(syntheticSummary, judgeOptions).ok, true);
    } finally {
      if (previousJson === undefined) {
        delete process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON;
      } else {
        process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON = previousJson;
      }
      if (previousUnsafeLocal === undefined) {
        delete process.env.AGENTOJ_ALLOW_UNSAFE_LOCAL_HIDDEN_ORACLE;
      } else {
        process.env.AGENTOJ_ALLOW_UNSAFE_LOCAL_HIDDEN_ORACLE = previousUnsafeLocal;
      }
    }
  });
  it("fails closed when descriptor hash does not match runtime oracle metadata", () => {
    const problem = getHumanEvalProblem("humaneval-001");
    assert.ok(problem);
    const descriptor = JSON.stringify({
      schemaVersion: 2,
      problemId: problem.id,
      benchmarkId: problem.benchmarkId,
      adapterId: problem.adapterId,
      upstreamTaskId: problem.upstreamTaskId,
      oracleKind: "python-function-cases",
      entryPoint: "candidate",
      cases: [{ id: "evidence-case", args: [[1]], expected: 1 }],
      evidencePolicy: { originalEvidenceId: "descriptor-original", rerunEvidenceId: "descriptor-rerun" },
    });
    const previousJson = process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON;
    const previousUnsafeLocal = process.env.AGENTOJ_ALLOW_UNSAFE_LOCAL_HIDDEN_ORACLE;
    process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON = descriptor;
    process.env.AGENTOJ_ALLOW_UNSAFE_LOCAL_HIDDEN_ORACLE = "1";
    try {
      const mismatchedProblem: Problem = {
        ...problem,
        scoringMode: "scored-hidden",
        oracleMetadata: {
          kind: "generated-private",
          hiddenRequired: true,
          oracleDescriptorHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      };
      const failed = runHiddenOraclePatchVerification({
        benchmark: HUMANEVAL_BENCHMARK,
        adapter: HUMANEVAL_ADAPTER,
        problem: mismatchedProblem,
        submission: createPatchSubmission(mismatchedProblem, "versioned-hidden-hash-mismatch"),
        patch: passingPatch,
      });
      assert.equal(failed.result.passFail, "fail");
      assert.match(failed.stderr, /invalid|hashMismatch|descriptor hash does not match/);
    } finally {
      if (previousJson === undefined) {
        delete process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON;
      } else {
        process.env.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON = previousJson;
      }
      if (previousUnsafeLocal === undefined) {
        delete process.env.AGENTOJ_ALLOW_UNSAFE_LOCAL_HIDDEN_ORACLE;
      } else {
        process.env.AGENTOJ_ALLOW_UNSAFE_LOCAL_HIDDEN_ORACLE = previousUnsafeLocal;
      }
    }
  });
  it("builds digest-pinned Docker run arguments with containment flags", () => {
    const catalog = getImplementedProblemCatalog("humaneval-001");
    assert.ok(catalog);
    assert.equal(isPinnedDockerImageDigest(catalog.adapter.dockerImageDigest), true);

    const args = withPrivateOracle(catalog.problem, [{ id: "private-smoke", args: [[1]], expected: [1][0] }], (problem) =>
      dockerRunArgs(
        {
          benchmark: catalog.benchmark,
          adapter: catalog.adapter,
          problem,
          submission: createPatchSubmission(problem, "docker-args"),
          patch: passingPatch,
        },
        "/tmp/worktree",
      ),
    );

    assert.deepEqual(args.slice(0, 3), ["run", "--rm", "--name"]);
    assert.match(args[3], /^agentoj-humaneval-001-submission-humaneval-001-docker-args-[0-9a-f]+$/);
    assert.ok(args.includes("--network"));
    assert.ok(args.includes("none"));
    assert.ok(args.includes("--user"));
    assert.ok(args.includes("65534:65534"));
    assert.ok(args.includes("--cpus"));
    assert.ok(args.includes("--memory"));
    assert.ok(args.includes("--memory-swap"));
    assert.ok(args.includes("--pids-limit"));
    assert.ok(args.includes("--cap-drop"));
    assert.ok(args.includes("ALL"));
    assert.ok(args.includes("--security-opt"));
    assert.ok(args.includes("no-new-privileges"));
    assert.ok(args.includes("--read-only"));
    assert.ok(args.includes("--tmpfs"));
    assert.ok(args.includes("/tmp:rw,noexec,nosuid,size=64m"));
    assert.ok(args.includes("/run:rw,noexec,nosuid,size=8m"));
    assert.ok(args.includes("/tmp/worktree/solution.py:/solution/solution.py:ro,z"));
    assert.equal(args.some((arg) => arg.includes("/work/tests") || arg.endsWith(":/work:rw,z")), false);
    assert.ok(args.includes("PYTHONPATH=/solution"));
    assert.ok(args.includes("PYTHONDONTWRITEBYTECODE=1"));
    assert.equal(args.includes("--env-file"), false);
    assert.equal(args.some((arg) => arg.includes("SECRET")), false);
    assert.equal(args.includes(catalog.adapter.dockerImageDigest), true);
    assert.equal(args.some((arg) => arg.includes("private-smoke") || arg.includes("\"args\"")), false);

    assert.equal(isPinnedDockerImageDigest("python:3.12-slim"), false);
    assert.throws(
      () =>
        withPrivateOracle(catalog.problem, [{ id: "private-smoke", args: [[1]], expected: [1][0] }], (problem) =>
          dockerRunArgs(
            {
              benchmark: catalog.benchmark,
              adapter: { ...catalog.adapter, dockerImageDigest: "python:3.12-slim" },
              problem,
              submission: createPatchSubmission(problem, "docker-args-bad"),
              patch: passingPatch,
            },
            "/tmp/worktree",
          ),
        ),
      /digest-pinned/,
    );
  });
  it("does not emit private hidden-oracle pass markers", () => {
    assert.equal(privateOracleStdout(["first-hidden-case"], false), "");
    assert.equal(privateOracleStdout(["first-hidden-case", "second-hidden-case"], true), "");
  });

  it("runs every seeded HumanEval fixture with its matching patch", () => {
    for (const [problemId, patch] of [
      ["humaneval-001", passingPatch],
      ["humaneval-002", largestPatch],
      ["humaneval-003-adapter-only", reversePatch],
    ] as const) {
      const problem = getHumanEvalProblem(problemId);
      assert.ok(problem);
      const verification = runLocalPatchVerification({
        benchmark: HUMANEVAL_BENCHMARK,
        adapter: HUMANEVAL_ADAPTER,
        problem,
        submission: createPatchSubmission(problem, `fixture-${problemId}`),
        patch,
      });
      assert.equal(verification.result.passFail, "pass", problemId);
    }
  });

  it("runs every seeded MBPP fixture with its matching patch", () => {
    for (const [problemId, patch] of [
      ["mbpp-001-adapter-only", mbppReversePatch],
      ["mbpp-002-adapter-only", mbppCountVowelsPatch],
      ["mbpp-003-adapter-only", mbppSumUniquePatch],
    ] as const) {
      const catalog = getImplementedProblemCatalog(problemId);
      assert.ok(catalog);
      const verification = runLocalPatchVerification({
        benchmark: catalog.benchmark,
        adapter: catalog.adapter,
        problem: catalog.problem,
        submission: createPatchSubmission(catalog.problem, `fixture-${problemId}`),
        patch,
      });
      assert.equal(verification.result.passFail, "pass", problemId);
      assert.equal(verification.job.resources.networkPolicy, "blocked", problemId);
    }
  });
});

describe("CLI runner prototype", () => {
  it("lists, shows, and reports adapter registry metadata", () => {
    const listed = runCli(["list"]);
    assert.equal(listed.ok, true);
    assert.equal(listed.problems?.length, 232);
    assert.equal(listed.problems?.some((problem) => problem.id === "humaneval-002"), true);
    assert.equal(listed.problems?.some((problem) => problem.id === "mbpp-001-adapter-only" && problem.hostingMode === "adapter-only"), true);
    assert.equal(listed.problems?.some((problem) => problem.id === "swe-bench-verified-astropy-12907" && problem.benchmarkId === "swe-bench-verified"), true);

    const shown = runCli(["show", "humaneval-003-adapter-only"]);
    assert.equal(shown.ok, true);
    assert.equal(shown.problem?.hostingMode, "adapter-only");
    assert.equal(shown.problem?.upstreamTaskId, "HumanEval/3");
    const shownMbpp = runCli(["show", "mbpp-001-adapter-only"]);
    assert.equal(shownMbpp.ok, true);
    assert.equal(shownMbpp.problem?.benchmarkId, "mbpp");
    assert.equal(shownMbpp.problem?.hostingMode, "adapter-only");
    assert.equal(shownMbpp.problem?.upstreamTaskId, "MBPP/adapter-seed-001");
    const shownFull = runCli(["show", "humaneval-full-000"]);
    assert.equal(shownFull.ok, true);
    assert.deepEqual(Object.keys(shownFull.problem ?? {}).sort(), [
      "adapterId",
      "benchmarkId",
      "hostingMode",
      "id",
      "oracleDescriptorHash",
      "scoringMode",
      "tags",
      "title",
      "upstreamTaskId",
    ]);
    assert.equal(shownFull.problem?.scoringMode, "scored-hidden");
    assert.match(String(shownFull.problem?.oracleDescriptorHash), /^sha256:[0-9a-f]{64}$/);
    const shownFullJson = JSON.stringify(shownFull.problem);
    assert.equal(shownFullJson.includes("testSource"), false);
    assert.equal(shownFullJson.includes("cases"), false);
    assert.equal(shownFullJson.includes("originalEvidenceId"), false);
    assert.equal(shownFullJson.includes("rerunEvidenceId"), false);
    const shownQuixbugs = runCli(["show", "quixbugs-python-bitcount"]);
    assert.equal(shownQuixbugs.ok, true);
    assert.deepEqual(Object.keys(shownQuixbugs.problem ?? {}).sort(), [
      "adapterId",
      "benchmarkId",
      "hostingMode",
      "id",
      "oracleDescriptorHash",
      "scoringMode",
      "tags",
      "title",
      "upstreamTaskId",
    ]);
    assert.equal(shownQuixbugs.problem?.scoringMode, "scored-hidden");
    assert.match(String(shownQuixbugs.problem?.oracleDescriptorHash), /^sha256:[0-9a-f]{64}$/);
    const shownQuixbugsJson = JSON.stringify(shownQuixbugs.problem);
    assert.equal(shownQuixbugsJson.includes("testSource"), false);
    assert.equal(shownQuixbugsJson.includes("hiddenTestBundleHash"), false);
    assert.equal(shownQuixbugsJson.includes("cases"), false);
    assert.equal(shownQuixbugsJson.includes("originalEvidenceId"), false);
    assert.equal(shownQuixbugsJson.includes("rerunEvidenceId"), false);


    const registry = runCli(["registry"]);
    assert.equal(registry.ok, true);
    assert.equal(registry.registry?.some((entry) => entry.benchmarkId === "mbpp" && entry.licenseId === "Apache-2.0"), true);
    assert.equal(registry.registry?.some((entry) => entry.benchmarkId === "mbpp" && entry.status === "implemented" && entry.dataPolicy === "full-hidden-plus-fixture-seed"), true);
    assert.equal(registry.registry?.some((entry) => entry.benchmarkId === "humaneval" && entry.status === "implemented" && entry.dataPolicy === "full-hidden-plus-fixture-seed"), true);
    assert.equal(registry.registry?.some((entry) => entry.benchmarkId === "swe-bench-lite" && entry.status === "implemented" && entry.dataPolicy === "full-hidden-plus-fixture-seed"), true);
  });
  it("turns a patch file into a private demo recording without public promotion", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentoj-cli-"));
    const patchPath = join(dir, "fix.diff");
    writeFileSync(patchPath, passingPatch, "utf8");

    const result = runCli(["run", "humaneval-001", "--patch", patchPath]);

    assert.equal(result.ok, true);
    assert.equal(result.problemId, "humaneval-001");
    assert.equal(result.patchBytes > 0, true);
    assert.match(result.recordingId ?? "", /^recording-/);
    assert.equal(result.leaderboardEntryId, undefined);
    assert.equal(result.publicMemoryLink, undefined);
    assert.equal(result.evidenceHash, undefined);
    assert.equal(result.sandboxMode, "local");
    assert.equal(result.oracleMode, "public-fixture-demo");
  });

  it("runs an MBPP adapter-only fixture through the CLI", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentoj-cli-mbpp-"));
    const patchPath = join(dir, "fix.diff");
    writeFileSync(patchPath, mbppReversePatch, "utf8");

    const result = runCli(["run", "mbpp-001-adapter-only", "--patch", patchPath]);

    assert.equal(result.ok, true);
    assert.equal(result.problemId, "mbpp-001-adapter-only");
    assert.equal(result.patchBytes > 0, true);
    assert.match(result.recordingId ?? "", /^recording-/);
    assert.equal(result.leaderboardEntryId, undefined);
    assert.equal(result.publicMemoryLink, undefined);
    assert.equal(result.sandboxMode, "local");
    assert.equal(result.oracleMode, "public-fixture-demo");
  });

  it("judges a PR submission without creating recordings or public memory", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentoj-cli-judge-"));
    const patchPath = join(dir, "fix.diff");
    const submissionPath = join(dir, "submission.json");
    const summaryPath = join(dir, "summary.json");
    writeFileSync(patchPath, passingPatch, "utf8");
    writeFileSync(submissionPath, JSON.stringify(prSubmissionEnvelope("humaneval-001", "humaneval-python", passingPatch)), "utf8");

    const result = runCli(["judge-pr-submission", "--submission", submissionPath, "--patch", patchPath, "--summary-out", summaryPath]);

    assert.equal(result.ok, false);
    assert.equal(result.runnerStatus, "invalid");
    assert.equal(result.sandboxMode, undefined);
    assert.equal(result.oracleMode, undefined);
    assert.equal(result.recordingId, undefined);
    assert.equal(result.leaderboardEntryId, undefined);
    assert.equal(result.publicMemoryLink, undefined);
    assert.equal(result.persistedDbPath, undefined);
    const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as { status: string; passFail: string; validationMessages: string[]; resultHash: string };
    assert.equal(summary.status, "invalid");
    assert.equal(summary.passFail, "fail");
    assert.match(summary.validationMessages.join("\n"), /scoredHiddenRequired/);
    assert.match(summary.resultHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(summary).includes("stdout"), false);
    assert.equal(JSON.stringify(summary).includes("stderr"), false);
    assert.equal(validateSanitizedPrJudgeSummary(summary, judgeOptions).ok, true);

    const localSummaryPath = join(dir, "local-summary.json");
    const local = runCli(["judge-pr-submission", "--submission", submissionPath, "--patch", patchPath, "--summary-out", localSummaryPath, "--sandbox", "local"]);
    assert.equal(local.ok, false);
    assert.equal(local.runnerStatus, "invalid");
    assert.match(local.issues?.join("\n") ?? "", /prSubmission\.sandbox\.dockerRequired/);

    const executableSummaryPath = join(dir, "executable-summary.json");
    const executable = spawnSync(process.execPath, [
      "--experimental-strip-types",
      "src/cli.ts",
      "judge-pr-submission",
      "--submission",
      submissionPath,
      "--patch",
      patchPath,
      "--summary-out",
      executableSummaryPath,
    ], { encoding: "utf8" });
    assert.equal(executable.status, 1);
    const stdoutSummary = JSON.parse(executable.stdout) as Record<string, unknown>;
    assert.equal(stdoutSummary.status, "invalid");
    assert.equal(Object.hasOwn(stdoutSummary, "summaryPath"), false);
    assert.equal(Object.hasOwn(stdoutSummary, "judgeSummary"), false);
  });
  it("binds PR judge summaries to the trusted event head SHA", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentoj-cli-judge-sha-"));
    const patchPath = join(dir, "fix.diff");
    const submissionPath = join(dir, "submission.json");
    const summaryPath = join(dir, "summary.json");
    const envelope = prSubmissionEnvelope("humaneval-001", "humaneval-python", passingPatch);
    writeFileSync(patchPath, passingPatch, "utf8");
    writeFileSync(submissionPath, JSON.stringify({ ...envelope, prHeadSha: "1111111111111111111111111111111111111111" }), "utf8");

    const trustedSha = "2222222222222222222222222222222222222222";
    const result = runCli([
      "judge-pr-submission",
      "--submission",
      submissionPath,
      "--patch",
      patchPath,
      "--summary-out",
      summaryPath,
      "--expected-pr-head-sha",
      trustedSha,
    ]);
    const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as { prHeadSha: string; validationMessages: string[] };

    assert.equal(result.ok, false);
    assert.match(result.issues?.join("\n") ?? "", /prSubmission\.prHeadSha\.mismatch/);
    assert.equal(summary.prHeadSha, trustedSha);
    assert.match(summary.validationMessages.join("\n"), /prSubmission\.prHeadSha\.mismatch/);
    const omittedSummaryPath = join(dir, "omitted-summary.json");
    writeFileSync(submissionPath, JSON.stringify({ ...envelope, prHeadSha: undefined }), "utf8");
    const omitted = runCli([
      "judge-pr-submission",
      "--submission",
      submissionPath,
      "--patch",
      patchPath,
      "--summary-out",
      omittedSummaryPath,
      "--expected-pr-head-sha",
      trustedSha,
    ]);
    const omittedSummary = JSON.parse(readFileSync(omittedSummaryPath, "utf8")) as { prHeadSha: string; validationMessages: string[] };

    assert.equal(omitted.ok, false);
    assert.equal(omittedSummary.prHeadSha, trustedSha);
    assert.doesNotMatch(omitted.issues?.join("\n") ?? "", /prSubmission\.prHeadSha\.(invalid|mismatch)/);
    assert.doesNotMatch(omittedSummary.validationMessages.join("\n"), /prSubmission\.prHeadSha\.(invalid|mismatch)/);
  });
  it("emits sanitized failing and invalid PR judge summaries", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentoj-cli-judge-fail-"));
    const badPatchPath = join(dir, "bad.diff");
    const submissionPath = join(dir, "submission.json");
    const failedSummaryPath = join(dir, "failed-summary.json");
    const invalidSummaryPath = join(dir, "invalid-summary.json");
    const badPatch = passingPatch.replace("    return None", "    return missing");
    writeFileSync(badPatchPath, badPatch, "utf8");
    writeFileSync(submissionPath, JSON.stringify(prSubmissionEnvelope("humaneval-001", "humaneval-python", badPatch)), "utf8");

    const failed = runCli(["judge-pr-submission", "--submission", submissionPath, "--patch", badPatchPath, "--summary-out", failedSummaryPath]);

    assert.equal(failed.ok, false);
    assert.ok(["invalid", "failed", "infra-error"].includes(failed.runnerStatus), failed.runnerStatus);
    const failedSummary = JSON.parse(readFileSync(failedSummaryPath, "utf8")) as { status: string; passFail: string; validationMessages: string[] };
    assert.ok(["invalid", "failed", "infra-error"].includes(failedSummary.status), failedSummary.status);
    assert.equal(failedSummary.passFail, "fail");
    assert.equal(JSON.stringify(failedSummary).includes("missing"), false);
    assert.equal(validateSanitizedPrJudgeSummary(failedSummary, judgeOptions).ok, true);

    const invalidEnvelope = prSubmissionEnvelope("unknown-problem", "humaneval-python", badPatch);
    writeFileSync(submissionPath, JSON.stringify(invalidEnvelope), "utf8");
    const invalid = runCli(["judge-pr-submission", "--submission", submissionPath, "--patch", badPatchPath, "--summary-out", invalidSummaryPath]);

    assert.equal(invalid.ok, false);
    assert.equal(invalid.runnerStatus, "invalid");
    assert.match(invalid.issues?.join("\n") ?? "", /prSubmission\.problem\.disabled/);
    const invalidSummary = JSON.parse(readFileSync(invalidSummaryPath, "utf8")) as { status: string; validationMessages: string[] };
    assert.equal(invalidSummary.status, "invalid");
    assert.equal(JSON.stringify(invalidSummary).includes("diff --git"), false);
    assert.equal(validateSanitizedPrJudgeSummary(invalidSummary, judgeOptions).ok, true);
  });

  it("rejects mismatched PR adapter ids and stale patch statistics before judging", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentoj-cli-judge-invalid-"));
    const patchPath = join(dir, "fix.diff");
    const submissionPath = join(dir, "submission.json");
    const summaryPath = join(dir, "summary.json");
    writeFileSync(patchPath, passingPatch, "utf8");

    const mismatchedAdapter = prSubmissionEnvelope("humaneval-001", "mbpp-python", passingPatch);
    writeFileSync(submissionPath, JSON.stringify(mismatchedAdapter), "utf8");
    const adapterResult = runCli(["judge-pr-submission", "--submission", submissionPath, "--patch", patchPath, "--summary-out", summaryPath]);
    assert.equal(adapterResult.ok, false);
    assert.equal(adapterResult.runnerStatus, "invalid");
    assert.match(adapterResult.issues?.join("\n") ?? "", /prSubmission\.adapter\.mismatch/);

    const staleStats = {
      ...prSubmissionEnvelope("humaneval-001", "humaneval-python", passingPatch),
      patchStats: { filesChanged: 1, locAdded: 0, locDeleted: 0 },
    };
    writeFileSync(submissionPath, JSON.stringify(staleStats), "utf8");
    const statsResult = runCli(["judge-pr-submission", "--submission", submissionPath, "--patch", patchPath, "--summary-out", summaryPath]);
    assert.equal(statsResult.ok, false);
    assert.equal(statsResult.runnerStatus, "invalid");
    assert.match(statsResult.issues?.join("\n") ?? "", /prSubmission\.patchStats\.mismatch/);

    writeFileSync(patchPath, judgeAssetPatch, "utf8");
    writeFileSync(submissionPath, JSON.stringify(prSubmissionEnvelope("humaneval-001", "humaneval-python", judgeAssetPatch)), "utf8");
    const judgeAssetResult = runCli(["judge-pr-submission", "--submission", submissionPath, "--patch", patchPath, "--summary-out", summaryPath]);
    assert.equal(judgeAssetResult.ok, false);
    assert.equal(judgeAssetResult.runnerStatus, "invalid");
    assert.equal(judgeAssetResult.recordingId, undefined);
    const judgeAssetSummary = JSON.parse(readFileSync(summaryPath, "utf8")) as { status: string; validationMessages: string[] };
    assert.equal(judgeAssetSummary.status, "invalid");
    assert.match(judgeAssetResult.issues?.join("\n") ?? "", /prSubmission\.files\.pathMismatch/);
    assert.equal(JSON.stringify(judgeAssetSummary).includes("test_humaneval.py"), false);
  });
  it("binds PR envelope file declarations to parsed patch targets before running", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentoj-cli-judge-bind-"));
    const patchPath = join(dir, "fix.diff");
    const submissionPath = join(dir, "submission.json");
    const summaryPath = join(dir, "summary.json");

    const runInvalid = (patch: string, envelope: ReturnType<typeof prSubmissionEnvelope>) => {
      writeFileSync(patchPath, patch, "utf8");
      writeFileSync(submissionPath, JSON.stringify(envelope), "utf8");
      const result = runCli(["judge-pr-submission", "--submission", submissionPath, "--patch", patchPath, "--summary-out", summaryPath]);
      assert.equal(result.ok, false);
      assert.equal(result.runnerStatus, "invalid");
      assert.equal(result.sandboxMode, undefined);
      const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as { status: string; validationMessages: string[] };
      assert.equal(summary.status, "invalid");
      assert.equal(JSON.stringify(summary).includes("diff --git"), false);
      return result.issues?.join("\n") ?? "";
    };

    assert.match(
      runInvalid(passingPatch, {
        ...prSubmissionEnvelope("humaneval-001", "humaneval-python", passingPatch),
        files: [{ path: "tests/test_humaneval.py", changeType: "modify", gitMode: "100644", byteSize: 512, isBinary: false, isSymlink: false }],
      }),
      /prSubmission\.files\.pathMismatch/,
    );

    assert.match(
      runInvalid(passingPatch, {
        ...prSubmissionEnvelope("humaneval-001", "humaneval-python", passingPatch),
        files: [{ path: "solution.py", changeType: "add", gitMode: "100644", byteSize: 512, isBinary: false, isSymlink: false }],
      }),
      /prSubmission\.files\.changeTypeMismatch/,
    );

    const unsupportedPatch = passingPatch.replaceAll("solution.py", "solution.exe");
    assert.match(
      runInvalid(unsupportedPatch, {
        ...prSubmissionEnvelope("humaneval-001", "humaneval-python", unsupportedPatch),
        files: [{ path: "solution.exe", changeType: "modify", gitMode: "100644", byteSize: 512, isBinary: false, isSymlink: false }],
      }),
      /prSubmission\.file\.extensionUnsupported/,
    );

    const duplicatePatch = `${passingPatch}${passingPatch}`;
    assert.match(
      runInvalid(duplicatePatch, prSubmissionEnvelope("humaneval-001", "humaneval-python", duplicatePatch)),
      /patch\.target\.duplicate/,
    );

    const tooManyPatch = Array.from({ length: 21 }, (_, index) =>
      [
        `diff --git a/extra-${index}.py b/extra-${index}.py`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/extra-${index}.py`,
        "@@ -0,0 +1 @@",
        `+value_${index} = ${index}`,
        "",
      ].join("\n"),
    ).join("");
    const tooManyEnvelope = {
      ...prSubmissionEnvelope("humaneval-001", "humaneval-python", tooManyPatch),
      patchStats: { filesChanged: 21, locAdded: 21, locDeleted: 0 },
      files: Array.from({ length: 21 }, (_, index) => ({
        path: `extra-${index}.py`,
        changeType: "add" as const,
        gitMode: "100644",
        byteSize: 64,
        isBinary: false,
        isSymlink: false,
      })),
    };
    writeFileSync(patchPath, tooManyPatch, "utf8");
    writeFileSync(submissionPath, JSON.stringify(tooManyEnvelope), "utf8");
    const tooManyResult = runCli(["judge-pr-submission", "--submission", submissionPath, "--patch", patchPath, "--summary-out", summaryPath]);
    assert.equal(tooManyResult.ok, false);
    assert.equal(tooManyResult.runnerStatus, "invalid");
    assert.equal(tooManyResult.sandboxMode, undefined);
    assert.match(tooManyResult.issues?.join("\n") ?? "", /prSubmission\.files\.tooMany|prSubmission\.filesChanged\.bounds/);
    const tooManySummary = JSON.parse(readFileSync(summaryPath, "utf8")) as { status: string; patchStats: { filesChanged: number } };
    assert.equal(tooManySummary.status, "invalid");
    assert.equal(tooManySummary.patchStats.filesChanged, 20);
    assert.equal(validateSanitizedPrJudgeSummary(tooManySummary, judgeOptions).ok, true);
  });

  it("persists a verified run bundle when --out-dir is provided", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentoj-cli-"));
    const patchPath = join(dir, "fix.diff");
    const outDir = join(dir, "runs");
    writeFileSync(patchPath, passingPatch, "utf8");

    const result = runCli(["run", "humaneval-001", "--patch", patchPath, "--out-dir", outDir]);

    assert.equal(result.ok, true);
    assert.equal(result.persistedRunLine, undefined);
    assert.equal(result.persistedRunPath, undefined);
    assert.equal(result.leaderboardEntryId, undefined);
    assert.equal(result.publicMemoryLink, undefined);
  });

  it("does not persist successful local demo runs into public SQLite surfaces", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentoj-cli-"));
    const patchPath = join(dir, "fix.diff");
    const dbPath = join(dir, "agentoj.sqlite");
    writeFileSync(patchPath, passingPatch, "utf8");

    const result = runCli(["run", "humaneval-001", "--patch", patchPath, "--db", dbPath]);

    assert.equal(result.ok, true);
    assert.equal(result.persistedDbPath, undefined);
    const db = openAgentOjDatabase(dbPath);
    try {
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM solution_recordings").get() as { count: number }).count, 0);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM leaderboard_entries").get() as { count: number }).count, 0);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM public_memory_entries").get() as { count: number }).count, 0);
    } finally {
      db.close();
    }

    const exported = runCli(["export-recording", result.recordingId ?? "", "--db", dbPath]);
    assert.equal(exported.ok, false);
    assert.match(exported.error ?? "", /Unknown recording id/);

    const memory = runCli(["memory", "search", "--db", dbPath, "--error", "target edge case", "--framework", "python"]);
    assert.equal(memory.ok, true);
    assert.equal(memory.results?.length, 0);
    const webOut = join(dir, "web-data");
    const webData = runCli(["export-web-data", "--db", dbPath, "--out", webOut]);
    assert.equal(webData.ok, true);
    assert.equal(webData.exportedFiles?.length, 5);
    const exportedProblems = JSON.parse(readFileSync(join(webOut, "problems.json"), "utf8")) as Array<{ id: string }>;
    const exportedMemory = JSON.parse(readFileSync(join(webOut, "memory.json"), "utf8")) as Array<{ publicRecordingLink: string }>;
    assert.equal(exportedProblems.some((problem) => problem.id === "humaneval-001"), true);
    assert.equal(exportedProblems.some((problem) => problem.id === "humaneval-full-000"), true);
    assert.equal(exportedProblems.filter((problem) => problem.id.startsWith("humaneval-full-")).length, 164);
    assert.equal(exportedProblems.some((problem) => problem.id === "mbpp-full-003"), true);
    assert.equal(exportedProblems.some((problem) => problem.id.startsWith("quixbugs-python-")), true);
    assert.equal(exportedProblems.some((problem) => problem.id === "swe-bench-lite-astropy-12907"), true);
    assert.equal(exportedProblems.some((problem) => problem.id === "swe-bench-verified-astropy-12907"), true);
    assert.equal(exportedMemory.length, 0);
  });


  it("persists failed attempts into SQLite without creating recordings", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentoj-cli-"));
    const patchPath = join(dir, "bad.diff");
    const dbPath = join(dir, "agentoj.sqlite");
    writeFileSync(patchPath, passingPatch.replace("    return None", "    return missing"), "utf8");

    const result = runCli(["run", "humaneval-001", "--patch", patchPath, "--db", dbPath]);

    assert.equal(result.ok, false);
    assert.equal(result.persistedDbPath, dbPath);
    assert.equal(result.runnerStatus, "failed");
    const db = openAgentOjDatabase(dbPath);
    try {
      const failed = db.prepare("SELECT problem_id, error FROM failed_run_attempts").get() as { problem_id: string; error: string };
      const recordings = db.prepare("SELECT COUNT(*) AS count FROM solution_recordings").get() as { count: number };
      assert.equal(failed.problem_id, "humaneval-001");
      assert.match(failed.error, /Patch delete mismatch/);
      assert.equal(recordings.count, 0);
    } finally {
      db.close();
    }
  });

  it("reports unknown problem ids without throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentoj-cli-"));
    const patchPath = join(dir, "fix.diff");
    writeFileSync(patchPath, "diff --git a/x b/x\n+ok\n", "utf8");

    const result = runCli(["run", "unknown-problem", "--patch", patchPath]);

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /Unknown problem id/);
  });
});

describe("SQLite schema", () => {
  it("covers the contract, community, leaderboard, and memory tables", () => {
    const schema = readFileSync("schemas/sqlite.sql", "utf8");
    for (const table of [
      "benchmarks",
      "adapters",
      "problems",
      "submissions",
      "runner_jobs",
      "runner_results",
      "solution_recordings",
      "evidence_ledgers",
      "failed_run_attempts",
      "review_gates",
      "public_memory_entries",
      "checklist_cases",
      "leaderboard_entries",
      "discussion_posts",
      "tag_suggestions",
      "difficulty_votes",
      "approved_difficulties",
    ]) {
      assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`));
    }
    assert.match(schema, /PRAGMA foreign_keys = ON;/);
    assert.match(schema, /CHECK \(license_id IN \('MIT', 'Apache-2\.0', 'BSD-2-Clause', 'BSD-3-Clause'\)\)/);
    assert.match(schema, /CREATE INDEX IF NOT EXISTS idx_checklist_lookup/);
  });
});
