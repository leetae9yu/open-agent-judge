import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const PINNED_ACTION = /^[a-z0-9_.-]+\/[a-z0-9_.-]+@[0-9a-f]{40}$/i;

function workflow(path: string): string {
  return readFileSync(path, "utf8");
}

function workflowNames(): Record<string, string> {
  return {
    judge: workflow(".github/workflows/pr-judge.yml"),
    report: workflow(".github/workflows/pr-report.yml"),
    pages: workflow(".github/workflows/pages.yml"),
    ciSample: workflow("ci/github-actions-ci.yml"),
  };
}

function indentedBlock(text: string, header: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === header);
  assert.notEqual(start, -1, `missing ${header}`);
  const baseIndent = lines[start].match(/^ */)?.[0].length ?? 0;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && (line.match(/^ */)?.[0].length ?? 0) <= baseIndent) break;
    body.push(line);
  }
  return body.join("\n");
}

function topLevelBlock(text: string, name: string): string {
  return indentedBlock(text, `${name}:`);
}

function permissionMap(text: string): Map<string, string> {
  const block = topLevelBlock(text, "permissions");
  return new Map(
    block
      .split(/\r?\n/)
      .map((line) => line.trim().match(/^([a-z-]+):\s+([a-z-]+)$/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map((match) => [match[1], match[2]]),
  );
}

function actionRefs(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^(?:-\s+)?uses:\s+(.+)$/)?.[1])
    .filter((value): value is string => Boolean(value));
}

function triggerBlock(text: string, trigger: string): string {
  return indentedBlock(topLevelBlock(text, "on"), `  ${trigger}:`);
}

function pathsFor(text: string, trigger: string): string[] {
  const block = triggerBlock(text, trigger);
  const lines = block.split(/\r?\n/);
  const pathsIndex = lines.findIndex((line) => line.trim() === "paths:");
  if (pathsIndex === -1) return [];
  const paths: string[] = [];
  for (const line of lines.slice(pathsIndex + 1)) {
    const match = line.trim().match(/^-\s+'?([^']+)'?$/);
    if (match) paths.push(match[1]);
    else if (line.trim() && !line.startsWith("      ")) break;
  }
  return paths;
}

function assertPinnedActions(text: string): void {
  const refs = actionRefs(text);
  assert.ok(refs.length > 0, "workflow should use actions");
  for (const ref of refs) assert.match(ref, PINNED_ACTION, `${ref} must be pinned to a full commit SHA`);
  assert.equal(refs.some((ref) => /@v\d+\b/.test(ref)), false);
}

describe("GitHub Actions PR judge trust boundaries", () => {
  it("runs untrusted judging from pull_request with read-only authority and trusted manual reruns", () => {
    const { judge } = workflowNames();
    const permissions = permissionMap(judge);

    assert.match(judge, /^  pull_request:/m);
    assert.match(judge, /^  workflow_dispatch:/m);
    assert.match(judge, /pr_head_sha:/);
    assert.doesNotMatch(judge, /pull_request_target/);
    assert.equal(permissions.get("contents"), "read");
    assert.equal(permissions.has("pull-requests"), false);
    assert.equal(permissions.has("issues"), false);
    assert.equal(permissions.has("pages"), false);
    assert.equal(permissions.has("id-token"), false);
    assert.deepEqual(pathsFor(judge, "pull_request").sort(), [
      ".agentoj/submission.json",
      ".agentoj/submission.patch",
      ".github/workflows/pr-judge.yml",
      "fixtures/**",
      "package-lock.json",
      "package.json",
      "src/**",
      "tests/**",
    ].sort());
    assert.match(judge, /concurrency:\n  group: agentoj-pr-judge-\$\{\{ github\.event\.pull_request\.number \|\| inputs\.pr_head_sha \}\}\n  cancel-in-progress: true/);
    assert.match(judge, /timeout-minutes: 45/);
    assert.match(judge, /persist-credentials: false/);
    assert.match(judge, /docker version/);
    assert.match(judge, /judge-pr-submission/);
    assert.match(judge, /--sandbox docker/);
    assert.match(judge, /Smoke test Docker sandbox against trusted fixture/);
    assert.equal(judge.includes("npm ci"), existsSync("package-lock.json"));
    assert.match(judge, /\.github\/agentoj-smoke\/humaneval-001-pass\.diff/);
    assert.match(judge, /AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON/);
    assert.doesNotMatch(judge, /"cases":\[\{"id":"private-smoke-case","args":\[\[1\]\],"expected":1\}\]/);
    assert.match(judge, /secrets\.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON/);
    assert.doesNotMatch(judge, /AGENTOJ_QUIXBUGS_PRIVATE_DESCRIPTOR_BUNDLE_JSON/);
    assert.doesNotMatch(judge, /--test-name-pattern "validates QuixBugs private descriptor bundles"/);
    assert.match(judge, /swebench_instance_id/);
    assert.match(judge, /swebench_instance_id:\n        description: 'Allowlisted SWE-bench instance id for maintainer-triggered runs'\n        required: true/);
    assert.match(judge, /Validate SWE-bench private descriptor for submitted problem/);
    assert.match(judge, /Materialize private descriptor secret to path/);
    assert.match(judge, /AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_PATH=\$descriptor_path/);
    assert.match(judge, /readFileSync\(process\.env\.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_PATH/);
    assert.match(judge, /selectCanonicalPrivateOracleDescriptor/);
    assert.match(judge, /private descriptor does not match submitted problem/);
    assert.match(judge, /expectedOracleDescriptorHash: entry\.problem\.oracleMetadata\?\.oracleDescriptorHash/);
    assert.match(judge, /Install pinned SWE-bench harness/);
    assert.match(judge, /git checkout f7bbbb2ccdf479001d6467c9e34af59e44a840f9/);
    assert.match(judge, /python3 -m pip install --user -e \./);
    assert.match(judge, /docker pull swebench\/sweb\.eval\.x86_64\.astropy_1776_astropy-12907@sha256:f3f63bb87d581c0e7b47f900dd82165b71040e1758d3c29e915e2b18da9baf63/);
    assert.match(judge, /AGENTOJ_SWEBENCH_HARNESS_PATH: \$\{\{ github\.event_name == 'workflow_dispatch' && '\/tmp\/swe-bench' \|\| '' \}\}/);
    assert.match(judge, /--trigger \$\{\{ github\.event_name \}\}/);
    assert.match(judge, /--instance-id \$\{\{ inputs\.swebench_instance_id \|\| '' \}\}/);
    assert.doesNotMatch(judge, /AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON: \$\{\{ github\.event_name == 'workflow_dispatch' && secrets\.AGENTOJ_PRIVATE_ORACLE_DESCRIPTOR_JSON \|\| '' \}\}/);
    assert.match(judge, /--expected-pr-head-sha \$\{\{ github\.event\.pull_request\.head\.sha \|\| inputs\.pr_head_sha \}\}/);
    assert.match(judge, /agentoj-pr-judge-summary/);
    assert.doesNotMatch(judge, /deploy-pages|createComment|issues\.createComment/);
    assertPinnedActions(judge);
  });

  it("runs trusted default-branch judge code against PR submission files only", () => {
    const { judge } = workflowNames();

    const trustedCheckout = judge.indexOf("Checkout trusted judge code");
    const prCheckout = judge.indexOf("Checkout PR submission files only");
    const judgeStep = judge.indexOf("Judge sanitized PR submission with trusted code");
    assert.ok(trustedCheckout > 0, "trusted checkout step should exist");
    assert.ok(prCheckout > trustedCheckout, "PR files should be checked out after trusted code");
    assert.ok(judgeStep > prCheckout, "judge should run after both checkouts");
    assert.match(judge, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
    assert.match(judge, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| inputs\.pr_head_sha \}\}/);
    assert.match(judge, /path: pr-submission/);
    assert.match(judge, /sparse-checkout: \.agentoj/);
    assert.match(judge, /--submission pr-submission\/\.agentoj\/submission\.json/);
    assert.match(judge, /--patch pr-submission\/\.agentoj\/submission\.patch/);
  });

  it("reports only after validating and escaping the sanitized summary artifact", () => {
    const { report } = workflowNames();
    const permissions = permissionMap(report);

    assert.match(report, /^  workflow_run:/m);
    assert.match(report, /workflows: \[AgentOJ PR Judge\]/);
    assert.doesNotMatch(report, /pull_request_target/);
    assert.equal(permissions.get("actions"), "read");
    assert.equal(permissions.get("contents"), "write");
    assert.equal(permissions.has("pull-requests"), false);
    assert.equal(permissions.get("issues"), "write");
    assert.equal(permissions.get("pages"), "write");
    assert.equal(permissions.get("id-token"), "write");
    assert.doesNotMatch(report, /\.agentoj\/submission\.patch|\.agentoj\/submission\.json/);
    assert.match(report, /artifact\.name === 'agentoj-pr-judge-summary'/);
    assert.match(report, /getWorkflowRun/);
    assert.match(report, /run\.data\.name !== 'AgentOJ PR Judge'/);
    assert.match(report, /run\.data\.conclusion !== 'success'/);
    assert.match(report, /summaries\.length !== 1/);
    assert.match(report, /summary\.size_in_bytes > 64 \* 1024/);
    assert.match(report, /validateSanitizedPrJudgeSummary/);
    assert.match(report, /escapeMarkdown/);
    assert.match(report, /validationMessages\.map\(\(message\) => `- \$\{escapeMarkdown\(message\)\}`\)/);
    assert.match(report, /continue-on-error: true/);
    assert.match(report, /actions\/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e/);
    assert.match(report, /Publish passed result to static leaderboard/);
    assert.match(report, /web\/data\/leaderboard\.json/);
    assert.match(report, /steps\.download_summary\.outputs\.judge_conclusion == 'success'/);
    assert.doesNotMatch(report, /github\.event\.workflow_run\.conclusion == 'success' \|\| inputs\.run_id/);
    assert.match(report, /summary\.status !== 'passed'/);
    assertPinnedActions(report);

    const validateIndex = report.indexOf("Validate sanitized summary schema");
    const commentIndex = report.indexOf("Comment sanitized result on PR");
    const leaderboardIndex = report.indexOf("Publish passed result to static leaderboard");
    assert.ok(validateIndex > 0, "validator step should exist");
    assert.ok(leaderboardIndex > validateIndex, "leaderboard update must occur after validator step");
    assert.ok(commentIndex > validateIndex, "comment step must occur after validator step");
  });

  it("publishes Pages only from protected main or manual dispatch", () => {
    const { pages } = workflowNames();
    const permissions = permissionMap(pages);

    assert.match(pages, /^  push:\n    branches: \[main\]$/m);
    assert.deepEqual(pathsFor(pages, "push").sort(), [
      ".github/workflows/pages.yml",
      "fixtures/**",
      "package-lock.json",
      "package.json",
      "src/**",
      "web/**",
    ].sort());
    assert.match(pages, /^  workflow_dispatch:$/m);
    assert.doesNotMatch(pages, /pull_request|pull_request_target|workflow_run|label/);
    assert.equal(permissions.get("contents"), "read");
    assert.equal(permissions.get("pages"), "write");
    assert.equal(permissions.get("id-token"), "write");
    assert.equal(permissions.has("issues"), false);
    assert.equal(permissions.has("pull-requests"), false);
    assert.match(pages, /environment:\n      name: github-pages/);
    assert.match(pages, /if: \$\{\{ github\.ref == 'refs\/heads\/main' \}\}/);
    assert.match(pages, /ref: main/);
    assert.match(pages, /export-web-data --out web\/data/);
    assertPinnedActions(pages);
  });

  it("keeps the public ci sample pinned and least-privileged", () => {
    const { ciSample } = workflowNames();
    const permissions = permissionMap(ciSample);

    assert.match(ciSample, /^  pull_request:$/m);
    assert.equal(permissions.get("contents"), "read");
    assert.equal(permissions.has("issues"), false);
    assert.equal(permissions.has("pull-requests"), false);
    assert.equal(permissions.has("id-token"), false);
    assertPinnedActions(ciSample);
  });

  it("negative fixtures fail structural workflow policy checks", () => {
    const unpinned = "name: bad\non:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  t:\n    steps:\n      - uses: actions/checkout@v4\n";
    const overprivileged = "name: bad\non:\n  pull_request:\npermissions:\n  contents: write\n  issues: write\njobs:\n  t:\n    steps:\n      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5\n";
    assert.throws(() => assertPinnedActions(unpinned));
    assert.equal(permissionMap(overprivileged).get("contents"), "write");
    assert.equal(permissionMap(overprivileged).get("issues"), "write");
    assert.deepEqual(pathsFor(unpinned, "pull_request"), []);
  });
});
