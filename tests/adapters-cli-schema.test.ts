import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  HUMANEVAL_ADAPTER,
  HUMANEVAL_BENCHMARK,
  HUMANEVAL_PROBLEMS,
  MBPP_ADAPTER,
  MBPP_BENCHMARK,
  MBPP_PROBLEMS,
  createPatchSubmission,
  getImplementedProblemCatalog,
  getHumanEvalProblem,
  getMbppProblem,
  dockerRunArgs,
  isPinnedDockerImageDigest,
  runLocalPatchVerification,
  runHiddenOraclePatchVerification,
  readRunBundles,
  openAgentOjDatabase,
  validateHumanEvalAdapterSeed,
  validateMbppAdapterSeed,
  validateSanitizedPrJudgeSummary,
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function withPrivateOracle<T>(problem: Problem, cases: Array<{ id: string; args: unknown[]; expected: unknown }>, callback: (problem: Problem) => T): T {
  const descriptor = JSON.stringify({ problemId: problem.id, cases });
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
  it("pins a permissive upstream benchmark and validates the seeded problems", () => {
    assert.doesNotThrow(() => validateHumanEvalAdapterSeed());
    assert.equal(HUMANEVAL_BENCHMARK.licenseId, "MIT");
    assert.equal(HUMANEVAL_BENCHMARK.legalStatus, "approved");
    assert.equal(HUMANEVAL_ADAPTER.supportedHostingModes.includes("hosted"), true);
    assert.equal(HUMANEVAL_ADAPTER.supportedHostingModes.includes("adapter-only"), true);
    assert.equal(HUMANEVAL_PROBLEMS.length, 3);
    assert.equal(getHumanEvalProblem("humaneval-001")?.upstreamTaskId, "HumanEval/1");
    assert.deepEqual(getHumanEvalProblem("humaneval-001")?.editableFilePaths, ["solution.py"]);
    assert.equal(getHumanEvalProblem("humaneval-003-adapter-only")?.hostingMode, "adapter-only");
  });
});

describe("MBPP adapter-only seed", () => {
  it("pins Apache-2.0 metadata and validates adapter-only seeded problems", () => {
    assert.doesNotThrow(() => validateMbppAdapterSeed());
    assert.equal(MBPP_BENCHMARK.licenseId, "Apache-2.0");
    assert.equal(MBPP_BENCHMARK.legalStatus, "approved");
    assert.equal(MBPP_BENCHMARK.defaultHostingMode, "adapter-only");
    assert.deepEqual(MBPP_ADAPTER.supportedHostingModes, ["adapter-only"]);
    assert.equal(MBPP_ADAPTER.defaultResources.networkPolicy, "blocked");
    assert.equal(MBPP_PROBLEMS.length, 3);
    assert.equal(getMbppProblem("mbpp-001-adapter-only")?.upstreamTaskId, "MBPP/adapter-seed-001");
    assert.equal(getMbppProblem("mbpp-001-adapter-only")?.hostingMode, "adapter-only");
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
    assert.equal(listed.problems?.length, 6);
    assert.equal(listed.problems?.some((problem) => problem.id === "humaneval-002"), true);
    assert.equal(listed.problems?.some((problem) => problem.id === "mbpp-001-adapter-only" && problem.hostingMode === "adapter-only"), true);

    const shown = runCli(["show", "humaneval-003-adapter-only"]);
    assert.equal(shown.ok, true);
    assert.equal(shown.problem?.hostingMode, "adapter-only");
    assert.equal(shown.problem?.upstreamTaskId, "HumanEval/3");
    const shownMbpp = runCli(["show", "mbpp-001-adapter-only"]);
    assert.equal(shownMbpp.ok, true);
    assert.equal(shownMbpp.problem?.benchmarkId, "mbpp");
    assert.equal(shownMbpp.problem?.hostingMode, "adapter-only");
    assert.equal(shownMbpp.problem?.upstreamTaskId, "MBPP/adapter-seed-001");


    const registry = runCli(["registry"]);
    assert.equal(registry.ok, true);
    assert.equal(registry.registry?.some((entry) => entry.benchmarkId === "mbpp" && entry.licenseId === "Apache-2.0"), true);
    assert.equal(registry.registry?.some((entry) => entry.benchmarkId === "mbpp" && entry.status === "implemented" && entry.dataPolicy === "fixture-seed"), true);
    assert.equal(registry.registry?.some((entry) => entry.benchmarkId === "swe-bench-lite" && entry.dataPolicy === "metadata-only"), true);
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
    assert.deepEqual(exportedProblems.map((problem) => problem.id).sort(), ["humaneval-001", "humaneval-002", "humaneval-003-adapter-only"]);
    assert.equal(exportedProblems.some((problem) => problem.id.startsWith("mbpp-")), false);
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
