import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { approveRecording, createLeaderboardEntry, createPatchSubmission, createRunBundle, createSolutionRecording, createAgentOjServer, listAdapterRegistry, openAgentOjDatabase, persistRunBundleToSqlite, promoteToPublicMemory, runAutomaticCheck, searchSqlitePublicMemory, seedPermissiveCatalog, simulateSandboxVerification, type AgentOjApiConfig, withAgentOjRepository } from "../src/index.ts";
import { runCli } from "../src/cli.ts";

const servers: Server[] = [];

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "agentoj-public-mvp-")), "agentoj.sqlite");
}
const PRIVATE_ORACLE_HASH = `sha256:${"b".repeat(64)}`;

function seedPrivateScoredCatalog() {
  const catalog = seedPermissiveCatalog();
  return {
    ...catalog,
    hostedProblem: {
      ...catalog.hostedProblem,
      scoringMode: "scored-hidden" as const,
      oracleMetadata: {
        kind: "generated-private" as const,
        hiddenRequired: true as const,
        oracleDescriptorHash: PRIVATE_ORACLE_HASH,
        originalEvidenceId: "private-original-evidence",
        rerunEvidenceId: "private-rerun-evidence",
      },
    },
  };
}

function scoredVerification(submission: ReturnType<typeof createPatchSubmission>, adapter: ReturnType<typeof seedPermissiveCatalog>["adapter"], scenario: Parameters<typeof simulateSandboxVerification>[2], runSeed: string) {
  const verification = simulateSandboxVerification(submission, adapter, scenario, runSeed);
  return {
    ...verification,
    job: {
      ...verification.job,
      scoringStatus: "scored" as const,
      sandboxMode: "docker" as const,
      oracleDescriptorHash: PRIVATE_ORACLE_HASH,
    },
  };
}


async function withServer(config: Partial<AgentOjApiConfig> = {}) {
  const full: AgentOjApiConfig = {
    dbPath: tempDb(),
    host: "127.0.0.1",
    port: 0,
    allowedOrigins: [],
    localUserId: "local-user",
    runnerMode: "docker",
    authMode: "production-proxy",
    publicOrigin: "https://pages.example",
    trustedProxySecret: "edge-secret",
    csrfToken: "csrf-token",
    reviewerAllowlist: ["reviewer"],
    adminOperatorAllowlist: ["operator"],
    ...config,
  };
  const server = createAgentOjServer(full);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, full.host, resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  return { baseUrl: `http://${full.host}:${address.port}`, config: full };
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

const patch = [
  "diff --git a/solution.py b/solution.py",
  "--- a/solution.py",
  "+++ b/solution.py",
  "@@ -1,2 +1,2 @@",
  " def candidate(xs):",
  "-    return None",
  "+    return xs[0]",
  "",
].join("\n");

const badHumanEvalPatch = patch.replace("    return None", "    return missing");

const badMbppPatch = [
  "diff --git a/solution.py b/solution.py",
  "--- a/solution.py",
  "+++ b/solution.py",
  "@@ -1,2 +1,2 @@",
  " def candidate(text):",
  "-    return missing",
  "+    return text[::-1]",
  "",
].join("\n");

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    ),
  );
});

describe("public MVP release smoke", () => {
  it("keeps Pages static load viable while API mode denies direct bypass writes", async () => {
    const html = readFileSync("web/index.html", "utf8");
    const app = readFileSync("web/app.js", "utf8");
    const problems = JSON.parse(readFileSync("web/data/problems.json", "utf8")) as Array<{ id: string }>;
    assert.match(html, /\.\/app\.js/);
    assert.match(app, /agentojApiBase/);
    assert.match(app, /API error/);
    assert.equal(problems.some((problem) => problem.id === "humaneval-001"), true);

    const { baseUrl } = await withServer();
    const anonymous = await json<{ capabilities: { canSubmit: boolean; canDiscuss: boolean } }>(await fetch(`${baseUrl}/api/me`));
    assert.equal(anonymous.capabilities.canSubmit, false);
    assert.equal(anonymous.capabilities.canDiscuss, false);

    const directWrite = await fetch(`${baseUrl}/api/submissions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agentoj-csrf": "csrf-token" },
      body: JSON.stringify({ problemId: "humaneval-001", patch, visibility: "private" }),
    });
    assert.equal(directWrite.status, 401);

    const localShimWrite = await fetch(`${baseUrl}/api/submissions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agentoj-csrf": "csrf-token", "x-agentoj-user": "local-user" },
      body: JSON.stringify({ problemId: "humaneval-001", patch, visibility: "private" }),
    });
    assert.equal(localShimWrite.status, 401);

    const bearerAdminWrite = await fetch(`${baseUrl}/api/submissions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agentoj-csrf": "csrf-token", authorization: "Bearer secret-admin-token" },
      body: JSON.stringify({ problemId: "humaneval-001", patch, visibility: "private" }),
    });
    assert.equal(bearerAdminWrite.status, 401);
    const forgedIdentityWrite = await fetch(`${baseUrl}/api/submissions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentoj-csrf": "csrf-token",
        "x-agentoj-auth-user": "123",
        "x-agentoj-auth-login": "octocat",
        "x-agentoj-auth-roles": "user,reviewer,admin-operator",
      },
      body: JSON.stringify({ problemId: "humaneval-001", patch, visibility: "private" }),
    });
    assert.equal(forgedIdentityWrite.status, 401);

    const wrongProxySecretWrite = await fetch(`${baseUrl}/api/submissions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentoj-csrf": "csrf-token",
        "x-agentoj-proxy-secret": "wrong-secret",
        "x-agentoj-auth-user": "123",
        "x-agentoj-auth-login": "octocat",
        "x-agentoj-auth-roles": "user",
      },
      body: JSON.stringify({ problemId: "humaneval-001", patch, visibility: "private" }),
    });
    assert.equal(wrongProxySecretWrite.status, 401);

    const missingCsrfWrite = await fetch(`${baseUrl}/api/submissions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentoj-proxy-secret": "edge-secret",
        "x-agentoj-auth-user": "123",
        "x-agentoj-auth-login": "octocat",
        "x-agentoj-auth-roles": "user",
      },
      body: JSON.stringify({ problemId: "humaneval-001", patch, visibility: "private" }),
    });
    assert.equal(missingCsrfWrite.status, 403);

    const proxiedWrite = await fetch(`${baseUrl}/api/submissions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentoj-csrf": "csrf-token",
        "x-agentoj-proxy-secret": "edge-secret",
        "x-agentoj-auth-user": "123",
        "x-agentoj-auth-login": "octocat",
        "x-agentoj-auth-roles": "user",
      },
      body: JSON.stringify({ problemId: "humaneval-001", patch, visibility: "private" }),
    });
    assert.equal(proxiedWrite.status, 202);

    const discussion = await fetch(`${baseUrl}/api/problems/humaneval-001/discussions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentoj-csrf": "csrf-token",
        "x-agentoj-proxy-secret": "edge-secret",
        "x-agentoj-auth-user": "123",
        "x-agentoj-auth-login": "octocat",
        "x-agentoj-auth-roles": "user",
      },
      body: JSON.stringify({
        markdown:
          "Public discussion with AGENTOJ_TRUSTED_PROXY_SECRET=supersecret OPENAI_API_KEY=sk-public GITHUB_TOKEN=gh-public AWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF DATABASE_URL=sqlite:///tmp/leak.db API CSRF abc123 Authorization: Bearer bearer123 /var/lib/app/prod.sqlite /tmp/leak/path.txt stdout stderr diff --git return xs[0] oraclePath=/srv/private/oracle/cases.json result_bundle=/tmp/results/bundle.tgz api-origin=https://judge.internal container_id=abc123 https://user:pass@example.test ghp_123456789012345678901234567890123456 sk-1234567890abcdef eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature s&#101;cret=obfuscated-token.\n+ leaked_line\n- removed_line",
      }),
    });
    assert.equal(discussion.status, 201);
    const community = await fetch(`${baseUrl}/api/problems/humaneval-001/community`);
    assert.equal(community.status, 200);
    const communityBody = await community.text();
    assert.doesNotMatch(communityBody, /diff --git|return xs\[0\]|stdout|stderr|supersecret|abc123|prod\.sqlite|bearer123|leak\/path|leaked_line|removed_line|sk-public|gh-public|AKIA1234567890ABCDEF|leak\.db|oracle|result_bundle|judge\.internal|container_id|user:pass|ghp_|sk-123|eyJ|obfuscated-token/i);
  });

  it("documents production OAuth as a BFF boundary and keeps candidate benchmarks metadata-only", async () => {
    const { baseUrl } = await withServer({ authMode: "production-oauth", trustedProxySecret: undefined });
    const me = await json<{ auth: { mode: string; userId: string | null }; capabilities: { canSubmit: boolean; canReview: boolean } }>(
      await fetch(`${baseUrl}/api/me`),
    );
    assert.equal(me.auth.mode, "production-oauth");
    assert.equal(me.auth.userId, null);
    assert.equal(me.capabilities.canSubmit, false);
    assert.equal(me.capabilities.canReview, false);

    const oauthWrite = await fetch(`${baseUrl}/api/submissions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agentoj-csrf": "csrf-token" },
      body: JSON.stringify({ problemId: "humaneval-001", patch, visibility: "private" }),
    });
    assert.equal(oauthWrite.status, 401);

    const registry = listAdapterRegistry();
    const candidates = registry.filter((entry) => entry.status === "candidate");
    assert.deepEqual(candidates.map((entry) => entry.benchmark.id).sort(), ["quixbugs", "swe-bench-lite"]);
    for (const entry of candidates) {
      assert.equal(entry.dataPolicy, "metadata-only");
      assert.equal(entry.adapter, undefined);
      assert.equal(entry.benchmark.defaultHostingMode, "adapter-only");
      assert.equal(entry.benchmark.legalStatus, "approved");
      assert.match(entry.benchmark.licenseId, /^[A-Za-z0-9][A-Za-z0-9.-]+$/);
      assert.equal(entry.benchmark.redistributionRights, "clear");
      assert.match(`${entry.dataPolicy} ${entry.notes}`, /metadata only|Metadata-only|metadata-only/i);
    }
    const mbpp = registry.find((entry) => entry.benchmark.id === "mbpp");
    assert.ok(mbpp);
    assert.equal(mbpp.status, "implemented");
    assert.equal(mbpp.dataPolicy, "fixture-seed");
    assert.equal(mbpp.benchmark.defaultHostingMode, "adapter-only");
    assert.deepEqual(mbpp.adapter?.supportedHostingModes, ["adapter-only"]);

    const problems = await json<{ problems: Array<{ benchmarkId: string; hostingMode: string }> }>(await fetch(`${baseUrl}/api/problems`));
    assert.equal(problems.problems.some((problem) => problem.benchmarkId === "mbpp" && problem.hostingMode === "adapter-only"), true);
    assert.equal(problems.problems.some((problem) => ["quixbugs", "swe-bench-lite"].includes(problem.benchmarkId)), false);
  });

  it("smokes public memory/search/export trust without promoting unapproved data", async () => {
    const { baseUrl, config } = await withServer();
    const pending = withAgentOjRepository(config.dbPath, (repository) => {
      const submission = repository.submitPatch({ problemId: "humaneval-001", patch, userId: "github:123", visibility: "public-full" });
      const result = repository.runNextQueuedJob("local");
      assert.equal(result?.status, "passed");
      return repository.createPendingRecordingFromJob({
        jobId: submission.jobId,
        summary: "Verified first-element fix for target edge case.",
        rootCause: "Target edge case failed because the implementation returned no value.",
        fixDescription: "Return the first list item and keep the fixture verification passing.",
      });
    });
    assert.equal(pending.reviewStatus, "pending");

    const memory = await json<{ results: unknown[] }>(
      await fetch(`${baseUrl}/api/memory/search?errorSignature=target%20edge%20case&languageFramework=python`),
    );
    assert.deepEqual(memory.results, []);

    const recordings = await json<{ recordings: unknown[] }>(await fetch(`${baseUrl}/api/recordings`));
    assert.deepEqual(recordings.recordings, []);

    const pendingRecording = await fetch(`${baseUrl}/api/recordings/${pending.recordingId}`);
    assert.equal(pendingRecording.status, 404);

    const pendingExport = await fetch(`${baseUrl}/api/recordings/${pending.recordingId}/export`);
    assert.equal(pendingExport.status, 404);
  });
  it("redacts populated approved public recording reads and exports", async () => {
    const { baseUrl, config } = await withServer();
    const approved = (() => {
      const catalog = seedPrivateScoredCatalog();
      const submission = createPatchSubmission(catalog.hostedProblem, `github-123-${Date.now()}`);
      const verification = scoredVerification(submission, catalog.adapter, "pass", "original");
      const rerun = scoredVerification(submission, catalog.adapter, "pass", "rerun");
      const baseRecording = createSolutionRecording(catalog, submission, verification);
      const recording = {
        ...baseRecording,
        summary: "Approved public first-element troubleshooting summary with stdout stderr oauth_token ghp_123 session cookie abc123 secret=plainsecret token=plaintoken https://user:pass@example.test ghp_123456789012345678901234567890123456 sk-1234567890abcdef.",
        rootCause: "target edge case approved public root includes AGENTOJ_TRUSTED_PROXY_SECRET=supersecret OPENAI_API_KEY=sk-public GITHUB_TOKEN=gh-public AWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF DATABASE_URL=sqlite:///tmp/leak.db API CSRF abc123 Authorization: Bearer bearer123 /var/lib/app/prod.sqlite /tmp/leak/path.txt diff --git return xs[0] oraclePath=/srv/private/oracle/cases.json result_bundle=/tmp/results/bundle.tgz api-origin=https://judge.internal container_id=abc123 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature.",
        fixDescription: "Return the first element and keep the deterministic fixture passing.\n+ leaked_line\n- removed_line\n+ return xs[0]  # SHOULD_NOT_LEAK_PATCH\nsession token=shh456\ns&#101;cret=obfuscated-token",
      };
      const evidence = runAutomaticCheck(recording, rerun);
      const review = approveRecording(recording, "reviewer");
      const publicMemory = promoteToPublicMemory(recording, evidence, review);
      const leaderboard = createLeaderboardEntry(submission, verification);
      persistRunBundleToSqlite(config.dbPath, {
        ...createRunBundle({
          benchmark: catalog.benchmark,
          adapter: catalog.adapter,
          problem: catalog.hostedProblem,
          submission,
          runnerJob: verification.job,
          runnerResult: verification.result,
          recording,
          evidence,
          review,
          publicMemory,
          leaderboard,
        }),
        rerunRunnerJob: rerun.job,
        rerunRunnerResult: rerun.result,
      });
      return { recordingId: recording.id, publicSlug: publicMemory.publicSlug };
    })();

    const list = await fetch(`${baseUrl}/api/recordings`);
    const detail = await fetch(`${baseUrl}/api/recordings/${approved.recordingId}`);
    const exportResponse = await fetch(`${baseUrl}/api/recordings/${approved.recordingId}/export`);
    const memory = await fetch(`${baseUrl}/api/memory/search?errorSignature=target%20edge%20case%20approved%20public%20root&languageFramework=python`);
    for (const response of [list, detail, exportResponse, memory]) assert.equal(response.status, 200);
    const bodies = [await list.text(), await detail.text(), await exportResponse.text(), await memory.text()];
    assert.equal(bodies.some((body) => body.includes(approved.publicSlug)), true);
    const outDir = join(mkdtempSync(join(tmpdir(), "agentoj-pages-export-")), "web-data");
    const exported = runCli(["export-web-data", "--db", config.dbPath, "--out", outDir]);
    assert.equal(exported.ok, true);
    bodies.push(readFileSync(join(outDir, "recordings.json"), "utf8"));
    bodies.push(readFileSync(join(outDir, "memory.json"), "utf8"));
    for (const body of bodies) {
      assert.doesNotMatch(body, /SHOULD_NOT_LEAK_PATCH|diff --git|return xs\[0\]|Ran \\d+ tests?|OK\\n|stdout|stderr/i);
      assert.doesNotMatch(body, /edge-secret|csrf-token|agentoj\.sqlite|oauth_token|session_token|rawChainOfThought|ghp_123|abc123|supersecret|prod\.sqlite|shh456|plainsecret|plaintoken|bearer123|leak\/path|leaked_line|removed_line|sk-public|gh-public|AKIA1234567890ABCDEF|leak\.db|oracle|result_bundle|judge\.internal|container_id|user:pass|sk-123|eyJ|obfuscated-token/i);
    }
  });
  it("keeps failed MBPP and HumanEval runs out of public surfaces and redacts public reads", async () => {
    const { baseUrl, config } = await withServer();
    const failedAttempts = withAgentOjRepository(config.dbPath, (repository) => {
      const humanEval = repository.submitPatch({ problemId: "humaneval-001", patch: badHumanEvalPatch, userId: "github:123", visibility: "public-full" });
      const humanEvalResult = repository.runNextQueuedJob("local");
      assert.equal(humanEvalResult?.status, "failed");
      assert.equal(humanEvalResult.submissionId, humanEval.submissionId);

      const mbpp = repository.submitPatch({ problemId: "mbpp-001-adapter-only", patch: badMbppPatch, userId: "github:123", visibility: "public-full" });
      const mbppResult = repository.runNextQueuedJob("local");
      assert.equal(mbppResult?.status, "failed");
      assert.equal(mbppResult.submissionId, mbpp.submissionId);
      return [
        { submissionId: humanEval.submissionId, jobId: humanEval.jobId },
        { submissionId: mbpp.submissionId, jobId: mbpp.jobId },
      ];
    });

    const db = openAgentOjDatabase(config.dbPath);
    try {
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM failed_run_attempts").get() as { count: number }).count, 2);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM solution_recordings").get() as { count: number }).count, 0);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM leaderboard_entries").get() as { count: number }).count, 0);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM public_memory_entries").get() as { count: number }).count, 0);
    } finally {
      db.close();
    }

    const mcpResults = searchSqlitePublicMemory(config.dbPath, { errorSignature: "target edge case", languageFramework: "python" });
    assert.deepEqual(mcpResults, []);

    const leaderboard = await json<{ leaderboard: unknown[] }>(await fetch(`${baseUrl}/api/leaderboard`));
    assert.deepEqual(leaderboard.leaderboard, []);
    const recordings = await json<{ recordings: unknown[] }>(await fetch(`${baseUrl}/api/recordings`));
    assert.deepEqual(recordings.recordings, []);
    const memory = await json<{ results: unknown[] }>(
      await fetch(`${baseUrl}/api/memory/search?errorSignature=target%20edge%20case&languageFramework=python`),
    );
    assert.deepEqual(memory.results, []);

    for (const failedAttempt of failedAttempts) {
      for (const id of [failedAttempt.submissionId, failedAttempt.jobId, `failed-${failedAttempt.submissionId}`]) {
        const exportResponse = await fetch(`${baseUrl}/api/recordings/${encodeURIComponent(id)}/export`);
        assert.equal(exportResponse.status, 404);
        const body = await exportResponse.text();
        assert.doesNotMatch(body, /edge-secret|csrf-token|agentoj\.sqlite|patch_text|stdout|stderr|rawChainOfThought|oauth_token|session_token/i);
        assert.doesNotMatch(body, /diff --git|return missing|return text\[::-1\]/i);
      }
    }

    for (const path of ["/api/health", "/api/me", "/api/auth/csrf", "/api/problems", "/api/leaderboard", "/api/recordings"]) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.ok, true, path);
      const body = await response.text();
      assert.doesNotMatch(body, /edge-secret|csrf-token|agentoj\.sqlite|patch_text|stdout|stderr|rawChainOfThought|oauth_token|session_token/i, path);
      assert.doesNotMatch(body, /diff --git|return missing|return text\[::-1\]/i, path);
    }
  });
});
