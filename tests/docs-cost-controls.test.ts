import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { BENCHMARK_EXECUTION_POLICIES, HUMANEVAL_ADAPTER, MBPP_ADAPTER, validateBenchmarkExecutionRequest, validateSanitizedPrJudgeSummary } from "../src/index.ts";

describe("PR-based operating model docs and cost controls", () => {
  it("documents public PR submissions, sanitized memory, and optional Azure/API", () => {
    const readme = readFileSync("README.md", "utf8");
    const app = readFileSync("web/app.js", "utf8");

    assert.match(readme, /GitHub PRs are the default public submission surface/);
    assert.match(readme, /Public PR patches are public by design/);
    assert.match(readme, /Public memory is different: only sanitized summaries/);
    assert.match(readme, /Public Pages defaults to static JSON and read-only behavior/);
    assert.match(readme, /does not default to Azure or any live API/);
    assert.match(readme, /Azure VM\/API is optional\/manual demo infrastructure and may remain deallocated/);
    assert.match(app, /defaultApiBase = ""/);
    assert.match(readme, /Docker execution is fail-closed/);
    assert.match(readme, /Docker image provenance/);
    assert.match(readme, /image@sha256:<digest>/);
    assert.match(readme, /demo-public/);
    assert.match(readme, /scored-hidden/);
    assert.match(readme, /oracleDescriptorHash/);
    assert.match(readme, /Distinct original\/rerun evidence ids stay in private descriptor\/evidence-ledger state/);
    assert.match(readme, /Scored public judging must fail closed/);
    assert.doesNotMatch(readme, /docker-fallback-local/);
    assert.doesNotMatch(app, /example-internal-host\\.internal/);
  });

  it("ships OSS hygiene templates and hides operations inventory", () => {
    const readme = readFileSync("README.md", "utf8");
    const contributing = readFileSync("CONTRIBUTING.md", "utf8");
    const security = readFileSync("SECURITY.md", "utf8");
    const submissionTemplate = readFileSync(".agentoj/submission.example.json", "utf8");

    for (const path of [
      "CONTRIBUTING.md",
      "SECURITY.md",
      ".github/ISSUE_TEMPLATE/bug_report.yml",
      ".github/ISSUE_TEMPLATE/feature_request.yml",
      ".github/PULL_REQUEST_TEMPLATE.md",
      ".agentoj/submission.example.json",
    ]) {
      assert.equal(existsSync(path), true, path);
    }

    assert.match(readme, /OSS project hygiene/);
    assert.match(readme, /Dependency, GitHub Actions, and Docker image update rules/);
    assert.doesNotMatch(readme, /internal-host|prod-resource-group|prod-vm|cloud-region|vm-sku/i);
    assert.match(contributing, /GitHub Actions updates: resolve the upstream tag to a full commit SHA/);
    assert.match(contributing, /Docker image updates: record the upstream tag, resolved digest/);
    assert.match(security, /Reporting vulnerabilities/);
    assert.match(security, /Public data policy/);
    assert.match(contributing, /Scored-hidden problems require private or safe-generated oracle metadata/);
    assert.match(contributing, /distinct executions/);
    assert.match(security, /oracle\/container\/result-bundle\/API-origin leaks/);
    assert.match(security, /Public scored judging fails closed/);
    assert.match(submissionTemplate, /"publicSubmission": true/);
  });

  it("documents and tests public judge abuse and cost bounds", () => {
    const readme = readFileSync("README.md", "utf8");
    const judge = readFileSync(".github/workflows/pr-judge.yml", "utf8");

    assert.match(readme, /One active judge run per PR/);
    assert.match(readme, /cancel-in-progress: true/);
    assert.match(readme, /Patch\/file bounds/);
    assert.match(readme, /declared editable-file allowlists/);
    assert.match(readme, /Bounded runtime/);
    assert.match(readme, /No-network\/default sandbox/);
    assert.match(readme, /Low concurrency/);
    assert.match(readme, /superseded runs cancel/);
    assert.match(readme, /raw patch text, stdout, stderr/);
    assert.match(readme, /Hidden-oracle gate/);
    assert.match(readme, /Release redaction gate/);
    assert.match(readme, /credential URLs, cloud keys, JWTs, PEM\/private keys/);
    assert.match(readme, /QuixBugs Python \| 150KB \| 10 \| 75KB \| 120s \| 1 \| 1024MB/);
    assert.match(readme, /SWE-bench Lite \| 500KB \| 50 \| 200KB \| 45min \| 2 \| 6GB/);
    assert.match(readme, /max_workers=1/);
    assert.match(readme, /official harness commit, dataset revision, and resolved harness image digest/);
    assert.match(readme, /materializes the encrypted GitHub secret into a temporary `AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_PATH`/);
    assert.match(judge, /Materialize private descriptor secret to path/);
    assert.match(judge, /AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_PATH=\$descriptor_path/);
    assert.match(readme, /Command-construction or dry-run checks are labeled unit-only evidence/);
    assert.match(readme, /benchmark acceptance requires live Docker scoring/);

    const workflowLines = judge.split(/\r?\n/).map((line) => line.trim());
    assert.equal(workflowLines.includes("cancel-in-progress: true"), true);
    assert.equal(workflowLines.includes("timeout-minutes: 45"), true);
    assert.equal(workflowLines.some((line) => line === "contents: read"), true);
    assert.equal(workflowLines.some((line) => line.includes("node --experimental-strip-types src/cli.ts judge-pr-submission")), true);
    assert.equal(workflowLines.some((line) => line.includes("--sandbox docker")), true);
    assert.equal(workflowLines.some((line) => line.includes("agentoj-docker-smoke")), true);

    const quixbugsPolicy = BENCHMARK_EXECUTION_POLICIES.find((policy) => policy.benchmarkId === "quixbugs");
    assert.deepEqual(quixbugsPolicy?.resources, { timeoutSeconds: 120, cpuCores: 1, memoryMb: 1024, networkPolicy: "blocked" });
    assert.equal(quixbugsPolicy?.maxPatchBytes, 150_000);
    assert.equal(quixbugsPolicy?.maxPatchFiles, 10);
    assert.equal(quixbugsPolicy?.maxFileBytes, 75_000);

    const sweLitePolicy = BENCHMARK_EXECUTION_POLICIES.find((policy) => policy.benchmarkId === "swe-bench-lite");
    assert.deepEqual(sweLitePolicy?.resources, { timeoutSeconds: 2700, cpuCores: 2, memoryMb: 6144, networkPolicy: "blocked" });
    assert.equal(sweLitePolicy?.maxWorkers, 1);
    assert.equal(sweLitePolicy?.maintainerTriggeredOnly, true);
    assert.equal(sweLitePolicy?.explicitPrHeadShaRequired, true);
    assert.equal(sweLitePolicy?.allowlistedInstanceRequired, true);
    assert.equal(sweLitePolicy?.artifactRetentionDays, 7);

    const rejectedSwe = validateBenchmarkExecutionRequest({
      benchmarkId: "swe-bench-lite",
      resources: sweLitePolicy!.resources,
      trigger: "pull_request",
      maxWorkers: 2,
      artifactRetentionDays: 30,
    });
    assert.equal(rejectedSwe.ok, false);
    const rejectedCodes = rejectedSwe.issues.map((entry) => entry.code).join("\n");
    assert.match(rejectedCodes, /benchmarkPolicy\.trigger\.maintainerRequired/);
    assert.match(rejectedCodes, /benchmarkPolicy\.prHeadSha\.required/);
    assert.match(rejectedCodes, /benchmarkPolicy\.instance\.required/);
    assert.match(rejectedCodes, /benchmarkPolicy\.maxWorkers\.mismatch/);
    assert.match(rejectedCodes, /benchmarkPolicy\.artifactRetention\.mismatch/);

    const leakedSummary = validateSanitizedPrJudgeSummary({
      schemaVersion: 1,
      submissionId: "submission-leak",
      problemId: "humaneval-full-000",
      adapterId: "humaneval-python",
      prHeadSha: "a".repeat(40),
      status: "passed",
      passFail: "pass",
      runtimeMs: 1,
      patchStats: { filesChanged: 1, locAdded: 1, locDeleted: 0 },
      validationMessages: ["stdout leaked hidden oracle"],
      resultHash: "sha256:" + "b".repeat(64),
    });
    assert.equal(leakedSummary.ok, false);
    assert.equal(HUMANEVAL_ADAPTER.defaultResources.networkPolicy, "blocked");
    assert.equal(MBPP_ADAPTER.defaultResources.networkPolicy, "blocked");
  });
});
