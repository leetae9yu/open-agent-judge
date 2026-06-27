import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, describe, it } from "node:test";
import { createAgentOjServer, openAgentOjDatabase, type AgentOjApiConfig } from "../src/index.ts";

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


const failingPatch = [
  "diff --git a/solution.py b/solution.py",
  "--- a/solution.py",
  "+++ b/solution.py",
  "@@ -1,2 +1,2 @@",
  " def candidate(xs):",
  "-    return missing_context",
  "+    return xs[0]",
  "",
].join("\n");

const servers: Server[] = [];

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "agentoj-api-worker-")), "agentoj.sqlite");
}

async function withServer(dbPath: string) {
  const config: AgentOjApiConfig = {
    dbPath,
    host: "127.0.0.1",
    port: 0,
    allowedOrigins: ["*"],
    localUserId: "local-user",
    adminToken: "secret-admin-token",
    runnerMode: "local",
  };
  const server = createAgentOjServer(config);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, config.host, resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  return { baseUrl: `http://${config.host}:${address.port}` };
}

async function postJson(baseUrl: string, path: string, body: unknown, admin = false) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(admin ? { "x-agentoj-admin-token": "secret-admin-token" } : { "x-agentoj-user": "local-user" }),
    },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    ),
  );
});

describe("AgentOJ submission and worker lifecycle", () => {
  it("creates queued submissions and atomically terminalizes run-next claims", async () => {
    const dbPath = tempDb();
    const { baseUrl } = await withServer(dbPath);

    const first = (await (await postJson(baseUrl, "/api/submissions", { problemId: "humaneval-001", patch: passingPatch })).json()) as {
      submission: { jobId: string; status: string };
    };
    const second = (await (await postJson(baseUrl, "/api/submissions", { problemId: "humaneval-002", patch: largestPatch })).json()) as {
      submission: { jobId: string; status: string };
    };
    assert.equal(first.submission.status, "queued");
    assert.equal(second.submission.status, "queued");

    const anonymousRun = await fetch(`${baseUrl}/api/worker/run-next`, { method: "POST", body: "{}" });
    assert.equal(anonymousRun.status, 403);

    const results = await Promise.all([
      postJson(baseUrl, "/api/worker/run-next", {}, true).then((response) => response.json()),
      postJson(baseUrl, "/api/worker/run-next", {}, true).then((response) => response.json()),
    ]) as Array<{ result: { jobId: string; status: string } | null }>;

    assert.deepEqual(new Set(results.map((item) => item.result?.jobId)), new Set([first.submission.jobId, second.submission.jobId]));
    assert.equal(results.every((item) => item.result?.status === "passed"), true);

    const empty = (await (await postJson(baseUrl, "/api/worker/run-next", {}, true)).json()) as { result: unknown };
    assert.equal(empty.result, null);
  });

  it("runs a queued passing submission to a terminal result without public promotion", async () => {
    const dbPath = tempDb();
    const { baseUrl } = await withServer(dbPath);
    await postJson(baseUrl, "/api/submissions", { problemId: "humaneval-001", patch: passingPatch });

    const run = (await (await postJson(baseUrl, "/api/worker/run-next", {}, true)).json()) as {
      result: { status: string; resultId: string; recordingPromoted: boolean };
    };
    assert.equal(run.result.status, "passed");
    assert.equal(run.result.recordingPromoted, false);
    assert.ok(run.result.resultId);

    const db = openAgentOjDatabase(dbPath);
    try {
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM runner_jobs WHERE status = 'passed'").get() as { count: number }).count, 1);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM runner_results").get() as { count: number }).count, 1);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM solution_recordings").get() as { count: number }).count, 0);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM public_memory_entries").get() as { count: number }).count, 0);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM leaderboard_entries").get() as { count: number }).count, 0);
    } finally {
      db.close();
    }
  });
  it("rejects invalid sandbox mode and marks unavailable docker as infra-error", async () => {
    const dbPath = tempDb();
    const { baseUrl } = await withServer(dbPath);
    await postJson(baseUrl, "/api/submissions", { problemId: "humaneval-001", patch: passingPatch });

    const invalid = await postJson(baseUrl, "/api/worker/run-next", { sandboxMode: "magic" }, true);
    assert.equal(invalid.status, 400);

    const originalPath = process.env.PATH;
    process.env.PATH = "/nonexistent-agentoj-docker";
    try {
      const run = (await (await postJson(baseUrl, "/api/worker/run-next", { sandboxMode: "docker" }, true)).json()) as {
        result: { status: string; failedAttemptId?: string; recordingPromoted: boolean };
      };
      assert.equal(run.result.status, "infra-error");
      assert.ok(run.result.failedAttemptId);
      assert.equal(run.result.recordingPromoted, false);
    } finally {
      process.env.PATH = originalPath;
    }

    const db = openAgentOjDatabase(dbPath);
    try {
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM runner_jobs WHERE status = 'infra-error'").get() as { count: number }).count, 1);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM failed_run_attempts").get() as { count: number }).count, 1);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM solution_recordings").get() as { count: number }).count, 0);
    } finally {
      db.close();
    }
  });

  it("persists failed worker results without creating recordings or public memory", async () => {
    const dbPath = tempDb();
    const { baseUrl } = await withServer(dbPath);
    await postJson(baseUrl, "/api/submissions", { problemId: "humaneval-001", patch: failingPatch });

    const run = (await (await postJson(baseUrl, "/api/worker/run-next", {}, true)).json()) as {
      result: { status: string; failedAttemptId?: string; recordingPromoted: boolean };
    };
    assert.equal(run.result.status, "failed");
    assert.ok(run.result.failedAttemptId);
    assert.equal(run.result.recordingPromoted, false);

    const db = openAgentOjDatabase(dbPath);
    try {
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM runner_jobs WHERE status = 'failed'").get() as { count: number }).count, 1);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM runner_results WHERE pass_fail = 'fail'").get() as { count: number }).count, 1);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM failed_run_attempts").get() as { count: number }).count, 1);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM solution_recordings").get() as { count: number }).count, 0);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM public_memory_entries").get() as { count: number }).count, 0);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM leaderboard_entries").get() as { count: number }).count, 0);
    } finally {
      db.close();
    }
  });
});
