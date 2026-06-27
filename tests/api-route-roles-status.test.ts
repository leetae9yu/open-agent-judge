import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createAgentOjServer, type AgentOjApiConfig } from "../src/index.ts";

const servers: Server[] = [];

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "agentoj-roles-")), "agentoj.sqlite");
}

async function withServer(config: Partial<AgentOjApiConfig> = {}) {
  const fullConfig: AgentOjApiConfig = {
    dbPath: tempDbPath(),
    host: "127.0.0.1",
    port: 0,
    allowedOrigins: ["https://pages.example"],
    localUserId: "local-user",
    adminToken: "local-admin-token",
    runnerMode: "local",
    authMode: "production-proxy",
    publicOrigin: "https://pages.example",
    trustedProxySecret: "edge-secret",
    csrfToken: "csrf-token",
    reviewerAllowlist: ["reviewer"],
    adminOperatorAllowlist: ["operator"],
    ...config,
  };
  const server = createAgentOjServer(fullConfig);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, fullConfig.host, resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  return { baseUrl: `http://${fullConfig.host}:${address.port}` };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    ),
  );
});

function authHeaders(login: string, roles = "user"): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-agentoj-csrf": "csrf-token",
    "x-agentoj-proxy-secret": "edge-secret",
    "x-agentoj-auth-user": login,
    "x-agentoj-auth-login": login,
    "x-agentoj-auth-roles": roles,
  };
}

async function submitPatch(baseUrl: string, login = "member") {
  const response = await fetch(`${baseUrl}/api/submissions`, {
    method: "POST",
    headers: authHeaders(login),
    body: JSON.stringify({
      problemId: "humaneval-001",
      patch: "diff --git a/solution.py b/solution.py\n--- a/solution.py\n+++ b/solution.py\n@@ -1 +1 @@\n-pass\n+pass\n",
    }),
  });
  const body = (await response.json()) as { submission: { submissionId: string; jobId: string } };
  assert.equal(response.status, 202);
  return body.submission;
}

describe("AgentOJ route roles and sanitized status", () => {
  it("returns sanitized own submission status while denying cross-user reads", async () => {
    const { baseUrl } = await withServer();
    const submission = await submitPatch(baseUrl, "member");

    const own = await fetch(`${baseUrl}/api/submissions/${encodeURIComponent(submission.submissionId)}/status`, {
      headers: authHeaders("member"),
    });
    const ownBody = (await own.json()) as { status: { submissionId: string; jobId: string; status: string; result: unknown; failedAttempt: unknown } };
    assert.equal(own.status, 200);
    assert.equal(ownBody.status.submissionId, submission.submissionId);
    assert.equal(ownBody.status.jobId, submission.jobId);
    assert.equal(ownBody.status.status, "queued");
    assert.equal(ownBody.status.result, null);
    assert.equal(ownBody.status.failedAttempt, null);
    assert.doesNotMatch(JSON.stringify(ownBody), /patch_text|stdout|stderr|tmp|secret|chain-of-thought|raw reasoning/i);

    const other = await fetch(`${baseUrl}/api/submissions/${encodeURIComponent(submission.submissionId)}/status`, {
      headers: authHeaders("other"),
    });
    assert.equal(other.status, 404);

    const reviewer = await fetch(`${baseUrl}/api/submissions/${encodeURIComponent(submission.submissionId)}/status`, {
      headers: authHeaders("reviewer", "reviewer"),
    });
    assert.equal(reviewer.status, 200);
  });

  it("exposes reviewer queues and admin worker status without granting worker control to reviewers", async () => {
    const { baseUrl } = await withServer();
    await submitPatch(baseUrl, "member");

    const tag = await fetch(`${baseUrl}/api/tags/suggestions`, {
      method: "POST",
      headers: authHeaders("member"),
      body: JSON.stringify({ targetId: "humaneval-001", targetType: "problem", tag: "route-roles" }),
    });
    assert.equal(tag.status, 201);
    const tagBody = (await tag.json()) as { tag: { id: string } };
    const vote = await fetch(`${baseUrl}/api/problems/humaneval-001/difficulty/votes`, {
      method: "POST",
      headers: authHeaders("member"),
      body: JSON.stringify({ value: 4 }),
    });
    assert.equal(vote.status, 201);

    const userQueue = await fetch(`${baseUrl}/api/reviewer/queue`, { headers: authHeaders("member") });
    assert.equal(userQueue.status, 403);

    const adminQueue = await fetch(`${baseUrl}/api/reviewer/queue`, { headers: authHeaders("operator", "admin-operator") });
    assert.equal(adminQueue.status, 403);

    const adminTagApproval = await fetch(`${baseUrl}/api/admin/tags/${encodeURIComponent(tagBody.tag.id)}/approve`, {
      method: "POST",
      headers: authHeaders("operator", "admin-operator"),
    });
    assert.equal(adminTagApproval.status, 403);

    const reviewerQueue = await fetch(`${baseUrl}/api/reviewer/queue`, { headers: authHeaders("reviewer", "reviewer") });
    const queueBody = (await reviewerQueue.json()) as { queue: { pendingTags: Array<{ tag: string }>; difficultyVotes: Array<{ problemId: string; voteCount: number }> } };
    assert.equal(reviewerQueue.status, 200);
    assert.equal(queueBody.queue.pendingTags.some((item) => item.tag === "route-roles"), true);
    assert.equal(queueBody.queue.difficultyVotes.some((item) => item.problemId === "humaneval-001" && item.voteCount === 1), true);

    const reviewerWorker = await fetch(`${baseUrl}/api/admin/worker/status`, { headers: authHeaders("reviewer", "reviewer") });
    assert.equal(reviewerWorker.status, 403);

    const adminWorker = await fetch(`${baseUrl}/api/admin/worker/status`, { headers: authHeaders("operator", "admin-operator") });
    const workerBody = (await adminWorker.json()) as { worker: { counts: { queued: number }; jobs: Array<{ jobId: string; status: string }> } };
    assert.equal(adminWorker.status, 200);
    assert.equal(workerBody.worker.counts.queued >= 1, true);
    assert.equal(workerBody.worker.jobs.some((job) => job.status === "queued"), true);
    assert.doesNotMatch(JSON.stringify(workerBody), /patch_text|stdout|stderr|tmp|secret|chain-of-thought|raw reasoning/i);

    const deniedLocalWorker = await fetch(`${baseUrl}/api/worker/run-next`, {
      method: "POST",
      headers: authHeaders("operator", "admin-operator"),
      body: JSON.stringify({ sandboxMode: "local" }),
    });
    assert.equal(deniedLocalWorker.status, 400);
  });

  it("rejects oversized or too-broad patches before they enter the worker queue", async () => {
    const { baseUrl } = await withServer();
    const oversized = await fetch(`${baseUrl}/api/submissions`, {
      method: "POST",
      headers: authHeaders("member"),
      body: JSON.stringify({ problemId: "humaneval-001", patch: `diff --git a/solution.py b/solution.py\n+++ b/solution.py\n+${"x".repeat(200_001)}` }),
    });
    assert.equal(oversized.status, 400);

    const manyFilesPatch = Array.from({ length: 21 }, (_, index) => `diff --git a/f${index}.py b/f${index}.py\n+++ b/f${index}.py\n+pass`).join("\n");
    const tooManyFiles = await fetch(`${baseUrl}/api/submissions`, {
      method: "POST",
      headers: authHeaders("member"),
      body: JSON.stringify({ problemId: "humaneval-001", patch: manyFilesPatch }),
    });
    assert.equal(tooManyFiles.status, 400);
  });
});
