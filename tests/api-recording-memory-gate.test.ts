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

const failingPatch = [
  "diff --git a/solution.py b/solution.py",
  "--- a/solution.py",
  "+++ b/solution.py",
  "@@ -1,2 +1,2 @@",
  " def candidate(xs):",
  "-    return None",
  "+    return []",
  "",
].join("\n");

const recordingBody = {
  summary: "Post-hoc evidence: the patch returns the first Python list element and the adapter command passed.",
  rootCause: "The submitted baseline returned no value for the first-element task.",
  fixDescription: "Replace the placeholder return with xs[0] and verify through unittest discovery.",
};

const servers: Server[] = [];

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "agentoj-api-recording-")), "agentoj.sqlite");
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

async function getJson<T>(baseUrl: string, path: string): Promise<T> {
  return (await (await fetch(`${baseUrl}${path}`)).json()) as T;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    ),
  );
});

describe("AgentOJ recording review and public memory gate", () => {
  it("creates pending recordings only from passing demo jobs but keeps them ineligible for public promotion", async () => {
    const dbPath = tempDb();
    const { baseUrl } = await withServer(dbPath);

    const submission = (await (await postJson(baseUrl, "/api/submissions", { problemId: "humaneval-001", patch: passingPatch })).json()) as {
      submission: { jobId: string };
    };
    const run = (await (await postJson(baseUrl, "/api/worker/run-next", {}, true)).json()) as {
      result: { status: string; recordingPromoted: boolean };
    };
    assert.equal(run.result.status, "passed");
    assert.equal(run.result.recordingPromoted, false);

    const anonymousCreate = await postJson(baseUrl, "/api/admin/recordings/from-job", { jobId: submission.submission.jobId, ...recordingBody });
    assert.equal(anonymousCreate.status, 403);
    const rawCotCreate = await postJson(
      baseUrl,
      "/api/admin/recordings/from-job",
      { jobId: submission.submission.jobId, ...recordingBody, summary: "raw chain-of-thought transcript" },
      true,
    );
    assert.equal(rawCotCreate.status, 400);

    const createdResponse = await postJson(baseUrl, "/api/admin/recordings/from-job", { jobId: submission.submission.jobId, ...recordingBody }, true);
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json()) as { recording: { recordingId: string; reviewStatus: string } };
    assert.equal(created.recording.reviewStatus, "pending");

    const pendingList = await getJson<{ recordings: unknown[] }>(baseUrl, "/api/recordings");
    assert.deepEqual(pendingList.recordings, []);
    const pendingDetail = await fetch(`${baseUrl}/api/recordings/${created.recording.recordingId}`);
    assert.equal(pendingDetail.status, 404);
    const pendingSearch = await getJson<{ results: unknown[] }>(baseUrl, "/api/memory/search?errorSignature=edge&languageFramework=python");
    assert.deepEqual(pendingSearch.results, []);
    const pendingExport = await fetch(`${baseUrl}/api/recordings/${created.recording.recordingId}/export`);
    assert.equal(pendingExport.status, 404);

    const approvedResponse = await postJson(baseUrl, `/api/admin/recordings/${created.recording.recordingId}/approve`, {}, true);
    assert.equal(approvedResponse.status, 404);

    const recreatedResponse = await postJson(baseUrl, "/api/admin/recordings/from-job", { jobId: submission.submission.jobId, ...recordingBody }, true);
    const recreated = (await recreatedResponse.json()) as { recording: { recordingId: string; reviewStatus: string } };
    assert.equal(recreated.recording.recordingId, created.recording.recordingId);
    assert.equal(recreated.recording.reviewStatus, "pending");

    const publicList = await getJson<{ recordings: Array<{ id: string }> }>(baseUrl, "/api/recordings");
    assert.deepEqual(publicList.recordings, []);
    const publicDetail = await fetch(`${baseUrl}/api/recordings/${created.recording.recordingId}`);
    assert.equal(publicDetail.status, 404);
    const publicExportAfterApprovalAttempt = await fetch(`${baseUrl}/api/recordings/${created.recording.recordingId}/export`);
    assert.equal(publicExportAfterApprovalAttempt.status, 404);

    const publicSearch = await getJson<{ results: Array<{ publicRecordingLink: string; actionChecklist: string[] }> }>(
      baseUrl,
      "/api/memory/search?errorSignature=first-element%20task&languageFramework=python",
    );
    assert.deepEqual(publicSearch.results, []);

    const db = openAgentOjDatabase(dbPath);
    try {
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM solution_recordings").get() as { count: number }).count, 1);
      assert.equal((db.prepare("SELECT trusted_reviewer_approval_status FROM review_gates").get() as { trusted_reviewer_approval_status: string }).trusted_reviewer_approval_status, "pending");
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM public_memory_entries").get() as { count: number }).count, 0);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM checklist_cases").get() as { count: number }).count, 0);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM leaderboard_entries").get() as { count: number }).count, 0);
    } finally {
      db.close();
    }
  });

  it("rejects recording creation from failed worker jobs", async () => {
    const dbPath = tempDb();
    const { baseUrl } = await withServer(dbPath);
    const submission = (await (await postJson(baseUrl, "/api/submissions", { problemId: "humaneval-001", patch: failingPatch })).json()) as {
      submission: { jobId: string };
    };
    const run = (await (await postJson(baseUrl, "/api/worker/run-next", {}, true)).json()) as { result: { status: string } };
    assert.equal(run.result.status, "failed");

    const create = await postJson(baseUrl, "/api/admin/recordings/from-job", { jobId: submission.submission.jobId, ...recordingBody }, true);
    assert.equal(create.status, 404);

    const db = openAgentOjDatabase(dbPath);
    try {
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM solution_recordings").get() as { count: number }).count, 0);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM public_memory_entries").get() as { count: number }).count, 0);
    } finally {
      db.close();
    }
  });
});
