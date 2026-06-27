import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { HUMANEVAL_ADAPTER, MBPP_ADAPTER } from "../src/index.ts";

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
    assert.match(readme, /distinct `originalEvidenceId`\/`rerunEvidenceId`/);
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
    const workflowTests = readFileSync("tests/github-workflows.test.ts", "utf8");
    const contractTests = readFileSync("tests/contracts.test.ts", "utf8");
    const cliTests = readFileSync("tests/adapters-cli-schema.test.ts", "utf8");

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
    assert.match(contractTests, /requires hidden or generated private oracle metadata/);
    assert.match(contractTests, /rejects oracle, container, result-bundle, credential URL, key, JWT, and obfuscated public leaks/);

    assert.match(judge, /group: agentoj-pr-judge-\$\{\{ github\.event\.pull_request\.number \|\| inputs\.pr_head_sha \}\}/);
    assert.match(judge, /cancel-in-progress: true/);
    assert.match(judge, /timeout-minutes: 10/);
    assert.match(judge, /docker version/);
    assert.match(judge, /--sandbox docker/);
    assert.match(judge, /Smoke test Docker sandbox against trusted fixture/);
    assert.match(judge, /\.github\/agentoj-smoke\/humaneval-001-pass\.diff/);

    assert.match(workflowTests, /cancel-in-progress: true/);
    assert.match(workflowTests, /issues: write/);
    assert.match(workflowTests, /timeout-minutes: 10/);
    assert.match(workflowTests, /--sandbox docker/);
    assert.match(contractTests, /rejects disabled problems, oversized patches, unsupported files, and path escapes/);
    assert.match(contractTests, /rejects binary patches, symlink escapes, unsafe file modes, and oversized files/);
    assert.match(contractTests, /rejects judge summaries with pass\/status mismatch or unbounded message payloads/);
    assert.match(cliTests, /reports timed-out runner status/);
    assert.equal(HUMANEVAL_ADAPTER.defaultResources.networkPolicy, "blocked");
    assert.equal(MBPP_ADAPTER.defaultResources.networkPolicy, "blocked");
  });
});
