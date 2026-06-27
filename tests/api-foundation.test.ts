import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, type Server } from "node:http";
import { afterEach, describe, it } from "node:test";
import { AGENTOJ_API_JSON_BODY_LIMIT_BYTES, createAgentOjServer, openAgentOjDatabase, type AgentOjApiConfig } from "../src/index.ts";
import { runCli } from "../src/cli.ts";

const servers: Server[] = [];

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "agentoj-api-")), "agentoj.sqlite");
}

async function withServer(config: Partial<AgentOjApiConfig> = {}) {
  const fullConfig: AgentOjApiConfig = {
    dbPath: tempDbPath(),
    host: "127.0.0.1",
    port: 0,
    allowedOrigins: ["https://example.test"],
    localUserId: "local-user",
    adminToken: "secret-admin-token",
    runnerMode: "local",
    ...config,
  };
  const server = createAgentOjServer(fullConfig);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, fullConfig.host, resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  return { server, baseUrl: `http://${fullConfig.host}:${address.port}`, config: fullConfig };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    ),
  );
});

function postRawJson(baseUrl: string, body: string, headers: Record<string, string> = {}): Promise<{ status: number; body: { code?: string; error?: string } }> {
  const url = new URL("/api/submissions", baseUrl);
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", headers: { "content-type": "application/json", ...headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
      });
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {} });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}


describe("AgentOJ API foundation", () => {
  it("starts against SQLite and reports health without mutating CLI behavior", async () => {
    const { baseUrl } = await withServer();

    const response = await fetch(`${baseUrl}/api/health`);
    const body = (await response.json()) as { ok: boolean; service: string; sqlite: string; catalogProblems: number };

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.service, "agentoj-api");
    assert.equal(body.sqlite, "open");
    assert.equal(body.catalogProblems, 229);

    const cli = runCli(["serve", "--db", "local.sqlite", "--port", "4111"]);
    assert.equal(cli.ok, true);
    assert.equal(cli.api?.dbPath, "local.sqlite");
    assert.equal(cli.api?.port, 4111);
  });

  it("resolves anonymous, local, and admin auth without exposing admin access by default", async () => {
    const { baseUrl } = await withServer();

    const anonymous = await fetch(`${baseUrl}/api/me`);
    const anonymousBody = (await anonymous.json()) as { auth: { mode: string; isAdmin: boolean; userId: string | null } };
    assert.equal(anonymousBody.auth.mode, "anonymous");
    assert.equal(anonymousBody.auth.isAdmin, false);
    assert.equal(anonymousBody.auth.userId, null);

    const spoofed = await fetch(`${baseUrl}/api/me`, { headers: { "x-agentoj-user": "octocat" } });
    const spoofedBody = (await spoofed.json()) as { auth: { mode: string; isAdmin: boolean; userId: string | null } };
    assert.equal(spoofedBody.auth.mode, "anonymous");
    assert.equal(spoofedBody.auth.userId, null);

    const local = await fetch(`${baseUrl}/api/me`, { headers: { "x-agentoj-user": "local-user" } });
    const localBody = (await local.json()) as { auth: { mode: string; isAdmin: boolean; userId: string } };
    assert.equal(localBody.auth.mode, "local");
    assert.equal(localBody.auth.userId, "local-user");
    assert.equal(localBody.auth.isAdmin, false);

    const rejected = await fetch(`${baseUrl}/api/admin/health`);
    assert.equal(rejected.status, 403);
    const wrongAdmin = await fetch(`${baseUrl}/api/admin/health`, { headers: { authorization: "Bearer wrong-token" } });
    assert.equal(wrongAdmin.status, 403);

    const admin = await fetch(`${baseUrl}/api/admin/health`, { headers: { authorization: "Bearer secret-admin-token" } });
    const adminBody = (await admin.json()) as { ok: boolean; admin: boolean };
    assert.equal(admin.status, 200);
    assert.equal(adminBody.ok, true);
    assert.equal(adminBody.admin, true);
  });

  it("serves catalog reads through repository gates and hides unknown legal-status problems", async () => {
    const dbPath = tempDbPath();
    const db = openAgentOjDatabase(dbPath);
    try {
      db.prepare(
        `INSERT INTO benchmarks
          (id, name, upstream_url, upstream_commit_or_version, license_id, legal_status, redistribution_rights, default_hosting_mode)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("unknown-bench", "Unknown Bench", "https://example.test", "deadbeef", "MIT", "unknown", "clear", "hosted");
      db.prepare(
        `INSERT INTO adapters
          (id, benchmark_id, adapter_version, fetch_strategy, judge_command_json, verification_commands_json, supported_hosting_modes_json, docker_image_digest, resources_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("unknown-adapter", "unknown-bench", "0.0.0", "hosted-fixture", "[]", "[]", "[\"hosted\"]", "sha256:unknown", "{}");
      db.prepare(
        `INSERT INTO problems
          (id, benchmark_id, adapter_id, upstream_task_id, title, language_framework_tags_json, hosting_mode, enabled)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("unknown-problem", "unknown-bench", "unknown-adapter", "Unknown/1", "Should stay hidden", "[\"python\"]", "hosted", 1);
    } finally {
      db.close();
    }

    const { baseUrl } = await withServer({ dbPath });
    const problemsResponse = await fetch(`${baseUrl}/api/problems`);
    const problemsBody = (await problemsResponse.json()) as { problems: Array<{ id: string; benchmarkId: string; upstreamTaskId: string; hostingMode: string; scoringMode?: string; oracleDescriptorHash?: string }> };

    assert.equal(problemsResponse.status, 200);
    assert.equal(problemsBody.problems.some((problem) => problem.id === "humaneval-001"), true);
    assert.equal(problemsBody.problems.some((problem) => problem.id === "unknown-problem"), false);
    assert.equal(problemsBody.problems.some((problem) => problem.hostingMode === "adapter-only"), true);
    assert.equal(problemsBody.problems.some((problem) => problem.id === "humaneval-full-000"), true);

    const mbppScoredProblems = problemsBody.problems.filter((problem) => problem.benchmarkId === "mbpp" && problem.scoringMode === "scored-hidden");
    assert.equal(mbppScoredProblems.length, 50);
    assert.equal(new Set(mbppScoredProblems.map((problem) => problem.id)).size, 50);
    assert.equal(new Set(mbppScoredProblems.map((problem) => problem.upstreamTaskId)).size, 50);
    assert.equal(mbppScoredProblems.every((problem) => String(problem.id).startsWith("mbpp-full-")), true);
    assert.equal(mbppScoredProblems.some((problem) => String(problem.id).includes("adapter-only")), false);
    assert.equal(mbppScoredProblems.every((problem) => /^sha256:[0-9a-f]{64}$/.test(String(problem.oracleDescriptorHash))), true);
    const quixbugsScoredProblems = problemsBody.problems.filter((problem) => problem.benchmarkId === "quixbugs" && problem.scoringMode === "scored-hidden");
    assert.equal(quixbugsScoredProblems.length, 10);
    assert.equal(new Set(quixbugsScoredProblems.map((problem) => problem.id)).size, 10);
    assert.equal(new Set(quixbugsScoredProblems.map((problem) => problem.upstreamTaskId)).size, 10);
    assert.equal(quixbugsScoredProblems.every((problem) => String(problem.id).startsWith("quixbugs-python-")), true);
    assert.equal(quixbugsScoredProblems.every((problem) => /^sha256:[0-9a-f]{64}$/.test(String(problem.oracleDescriptorHash))), true);
    const swebenchLiteProblems = problemsBody.problems.filter((problem) => problem.benchmarkId === "swe-bench-lite" && problem.scoringMode === "scored-hidden");
    assert.equal(swebenchLiteProblems.length, 1);
    assert.equal(swebenchLiteProblems[0]?.id, "swe-bench-lite-astropy-12907");
    assert.equal(swebenchLiteProblems[0]?.upstreamTaskId, "astropy__astropy-12907");
    assert.match(String(swebenchLiteProblems[0]?.oracleDescriptorHash), /^sha256:[0-9a-f]{64}$/);


    const fullProblemResponse = await fetch(`${baseUrl}/api/problems/humaneval-full-000`);
    const fullProblemBody = (await fullProblemResponse.json()) as { problem: Record<string, unknown> };
    assert.equal(fullProblemResponse.status, 200);
    assert.deepEqual(Object.keys(fullProblemBody.problem).sort(), [
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
    assert.equal(fullProblemBody.problem.id, "humaneval-full-000");
    assert.equal(fullProblemBody.problem.scoringMode, "scored-hidden");
    assert.match(String(fullProblemBody.problem.oracleDescriptorHash), /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(fullProblemBody.problem.tags, ["python", "humaneval", "scored-hidden"]);
    assert.equal(JSON.stringify(fullProblemBody.problem).includes("testSource"), false);
    assert.equal(JSON.stringify(fullProblemBody.problem).includes("cases"), false);
    assert.equal(JSON.stringify(fullProblemBody.problem).includes("originalEvidenceId"), false);
    assert.equal(JSON.stringify(fullProblemBody.problem).includes("rerunEvidenceId"), false);

    const mbppFullResponse = await fetch(`${baseUrl}/api/problems/mbpp-full-003`);
    const mbppFullBody = (await mbppFullResponse.json()) as { problem: Record<string, unknown> };
    assert.equal(mbppFullResponse.status, 200);
    assert.deepEqual(Object.keys(mbppFullBody.problem).sort(), [
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
    assert.equal(mbppFullBody.problem.id, "mbpp-full-003");
    assert.equal(mbppFullBody.problem.scoringMode, "scored-hidden");
    assert.match(String(mbppFullBody.problem.oracleDescriptorHash), /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(mbppFullBody.problem.tags, ["python", "mbpp", "scored-hidden"]);
    assert.equal(JSON.stringify(mbppFullBody.problem).includes("test_list"), false);
    assert.equal(JSON.stringify(mbppFullBody.problem).includes("cases"), false);
    assert.equal(JSON.stringify(mbppFullBody.problem).includes("originalEvidenceId"), false);
    assert.equal(JSON.stringify(mbppFullBody.problem).includes("rerunEvidenceId"), false);
    const quixbugsFullResponse = await fetch(`${baseUrl}/api/problems/quixbugs-python-bitcount`);
    const quixbugsFullBody = (await quixbugsFullResponse.json()) as { problem: Record<string, unknown> };
    assert.equal(quixbugsFullResponse.status, 200);
    assert.deepEqual(Object.keys(quixbugsFullBody.problem).sort(), [
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
    assert.equal(quixbugsFullBody.problem.id, "quixbugs-python-bitcount");
    assert.equal(quixbugsFullBody.problem.scoringMode, "scored-hidden");
    assert.match(String(quixbugsFullBody.problem.oracleDescriptorHash), /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(quixbugsFullBody.problem.tags, ["python", "quixbugs", "bug-fix", "scored-hidden"]);
    assert.equal(JSON.stringify(quixbugsFullBody.problem).includes("testSource"), false);
    assert.equal(JSON.stringify(quixbugsFullBody.problem).includes("hiddenTestBundleHash"), false);
    assert.equal(JSON.stringify(quixbugsFullBody.problem).includes("cases"), false);
    assert.equal(JSON.stringify(quixbugsFullBody.problem).includes("originalEvidenceId"), false);
    assert.equal(JSON.stringify(quixbugsFullBody.problem).includes("rerunEvidenceId"), false);
    const swebenchLiteResponse = await fetch(`${baseUrl}/api/problems/swe-bench-lite-astropy-12907`);
    const swebenchLiteBody = (await swebenchLiteResponse.json()) as { problem: Record<string, unknown> };
    assert.equal(swebenchLiteResponse.status, 200);
    assert.deepEqual(Object.keys(swebenchLiteBody.problem).sort(), [
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
    assert.equal(swebenchLiteBody.problem.scoringMode, "scored-hidden");
    assert.equal(JSON.stringify(swebenchLiteBody.problem).includes("harnessCommit"), false);
    assert.equal(JSON.stringify(swebenchLiteBody.problem).includes("harnessImageDigest"), false);
    assert.equal(JSON.stringify(swebenchLiteBody.problem).includes("predictionJsonlSchemaHash"), false);
    assert.equal(JSON.stringify(swebenchLiteBody.problem).includes("originalEvidenceId"), false);

    const hiddenResponse = await fetch(`${baseUrl}/api/problems/unknown-problem`);
    assert.equal(hiddenResponse.status, 404);
    const invalidEncoding = await fetch(`${baseUrl}/api/problems/%E0%A4%A`);
    const invalidEncodingBody = (await invalidEncoding.json()) as { code: string; error: string };
    assert.equal(invalidEncoding.status, 400);
    assert.equal(invalidEncodingBody.code, "bad_request");


    const registryResponse = await fetch(`${baseUrl}/api/registry`);
    const registryBody = (await registryResponse.json()) as { registry: Array<{ benchmarkId: string; status: string; dataPolicy: string }> };
    assert.equal(registryBody.registry.some((entry) => entry.benchmarkId === "mbpp" && entry.status === "implemented" && entry.dataPolicy === "full-hidden-plus-fixture-seed"), true);
  });
  it("redacts unexpected internal errors from public responses", async () => {
    const directoryPath = mkdtempSync(join(tmpdir(), "agentoj-api-db-dir-"));
    const { baseUrl } = await withServer({ dbPath: directoryPath });

    const response = await fetch(`${baseUrl}/api/health`);
    const body = (await response.json()) as { code: string; error: string };

    assert.equal(response.status, 500);
    assert.equal(body.code, "internal_error");
    assert.equal(body.error, "Internal server error.");
    assert.doesNotMatch(JSON.stringify(body), /SQLITE|agentoj-api-db-dir|sqlite/i);
  });

  it("rejects oversized JSON bodies before buffering attacker-controlled payloads", async () => {
    const { baseUrl } = await withServer();
    const oversizedBody = JSON.stringify({ problemId: "humaneval-001", patch: "x".repeat(AGENTOJ_API_JSON_BODY_LIMIT_BYTES) });

    const preflightRejected = await postRawJson(baseUrl, "{}", {
      "content-length": String(AGENTOJ_API_JSON_BODY_LIMIT_BYTES + 1),
    });
    assert.equal(preflightRejected.status, 413);
    assert.equal(preflightRejected.body.code, "payload_too_large");
    assert.equal(preflightRejected.body.error, "Request JSON body is too large.");

    const streamingRejected = await postRawJson(baseUrl, oversizedBody);
    assert.equal(streamingRejected.status, 413);
    assert.equal(streamingRejected.body.code, "payload_too_large");
    assert.doesNotMatch(JSON.stringify(streamingRejected.body), /humaneval-001|xxxxx/);
  });
});
