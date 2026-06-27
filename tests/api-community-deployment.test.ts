import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, describe, it } from "node:test";
import { createAgentOjServer, openAgentOjDatabase, type AgentOjApiConfig } from "../src/index.ts";

const servers: Server[] = [];
const childProcesses: ChildProcessWithoutNullStreams[] = [];

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "agentoj-api-community-")), "agentoj.sqlite");
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

async function postJson(baseUrl: string, path: string, body: unknown, auth: "anonymous" | "local" | "admin" = "local") {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth === "admin" ? { "x-agentoj-admin-token": "secret-admin-token" } : auth === "local" ? { "x-agentoj-user": "local-user" } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function getJson<T>(baseUrl: string, path: string): Promise<T> {
  return (await (await fetch(`${baseUrl}${path}`)).json()) as T;
}

async function startCliServe(dbPath: string): Promise<string> {
  const child = spawn(process.execPath, ["--experimental-strip-types", "src/cli.ts", "serve", "--db", dbPath, "--host", "127.0.0.1", "--port", "0"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  childProcesses.push(child);
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for CLI API server.")), 5000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`CLI API server exited before readiness with code ${code}.`));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      const match = text.match(/AgentOJ API listening on .*:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    ),
  );
  for (const child of childProcesses.splice(0)) {
    if (!child.killed) child.kill("SIGTERM");
  }
});

describe("AgentOJ community endpoints and deployment smoke", () => {
  it("serves discussion, tag, and difficulty community surfaces with reviewer approval gates", async () => {
    const dbPath = tempDb();
    const { baseUrl } = await withServer(dbPath);
    const initial = await getJson<{ community: { discussions: unknown[]; approvedTags: string[]; difficulty: unknown; voteCount: number } }>(
      baseUrl,
      "/api/problems/humaneval-001/community",
    );
    assert.deepEqual(initial.community.discussions, []);
    assert.deepEqual(initial.community.approvedTags, []);
    assert.equal(initial.community.difficulty, null);
    assert.equal(initial.community.voteCount, 0);

    const anonymousDiscussion = await postJson(baseUrl, "/api/problems/humaneval-001/discussions", { markdown: "Anonymous local smoke note" }, "anonymous");
    assert.equal(anonymousDiscussion.status, 201);
    const anonymous = (await anonymousDiscussion.json()) as { discussion: { id: string } };
    const rawCotDiscussion = await postJson(baseUrl, "/api/problems/humaneval-001/discussions", { markdown: "raw chain-of-thought dump" });
    assert.equal(rawCotDiscussion.status, 400);

    const discussionResponse = await postJson(baseUrl, "/api/problems/humaneval-001/discussions", {
      markdown: "Evidence note: xs[0] solves the first-element fixture.",
    });
    assert.equal(discussionResponse.status, 201);
    const discussion = (await discussionResponse.json()) as { discussion: { id: string; moderationState: string } };
    assert.equal(discussion.discussion.moderationState, "visible");

    const tagResponse = await postJson(baseUrl, "/api/tags/suggestions", {
      targetId: "humaneval-001",
      targetType: "problem",
      tag: "First-Element",
    });
    assert.equal(tagResponse.status, 201);
    const tag = (await tagResponse.json()) as { tag: { id: string; tag: string; reviewerDecision: string } };
    assert.equal(tag.tag.tag, "first-element");
    assert.equal(tag.tag.reviewerDecision, "pending");

    const pending = await getJson<{ community: { approvedTags: string[] } }>(baseUrl, "/api/problems/humaneval-001/community");
    assert.deepEqual(pending.community.approvedTags, []);

    const approvedTagResponse = await postJson(baseUrl, `/api/admin/tags/${tag.tag.id}/approve`, {}, "admin");
    assert.equal(approvedTagResponse.status, 200);
    const duplicateTagResponse = await postJson(baseUrl, "/api/tags/suggestions", {
      targetId: "humaneval-001",
      targetType: "problem",
      tag: "first-element",
    });
    const duplicateTag = (await duplicateTagResponse.json()) as { tag: { reviewerDecision: string } };
    assert.equal(duplicateTag.tag.reviewerDecision, "approved");

    const invalidVote = await postJson(baseUrl, "/api/problems/humaneval-001/difficulty/votes", { value: 9 });
    assert.equal(invalidVote.status, 400);
    const voteResponse = await postJson(baseUrl, "/api/problems/humaneval-001/difficulty/votes", { value: 3 });
    assert.equal(voteResponse.status, 201);
    const anonymousApprove = await postJson(baseUrl, "/api/admin/problems/humaneval-001/difficulty/approve", {}, "anonymous");
    assert.equal(anonymousApprove.status, 403);
    const approvedDifficultyResponse = await postJson(baseUrl, "/api/admin/problems/humaneval-001/difficulty/approve", {}, "admin");
    assert.equal(approvedDifficultyResponse.status, 200);

    const community = await getJson<{
      community: {
        discussions: Array<{ id: string; markdown: string }>;
        approvedTags: string[];
        difficulty: { approvedValue: number; reviewerId: string };
        voteCount: number;
      };
    }>(baseUrl, "/api/problems/humaneval-001/community");
    assert.deepEqual(community.community.discussions.map((item) => item.id), [anonymous.discussion.id, discussion.discussion.id]);
    assert.equal(community.community.discussions[1].markdown.includes("xs[0]"), true);
    assert.deepEqual(community.community.approvedTags, ["first-element"]);
    assert.deepEqual(community.community.difficulty, { approvedValue: 3, reviewerId: "admin" });
    assert.equal(community.community.voteCount, 1);
    const db = openAgentOjDatabase(dbPath);
    try {
      assert.equal((db.prepare("SELECT reviewer_id FROM tag_suggestions WHERE id = ?").get(tag.tag.id) as { reviewer_id: string }).reviewer_id, "admin");
      assert.equal((db.prepare("SELECT reviewer_id FROM approved_difficulties WHERE problem_id = ?").get("humaneval-001") as { reviewer_id: string }).reviewer_id, "admin");
    } finally {
      db.close();
    }
  });

  it("keeps deployment cheap with Pages static fallback plus an API-mode smoke script", async () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    assert.equal(pkg.scripts["agentoj:serve"], "node --experimental-strip-types src/cli.ts serve");
    assert.equal(pkg.scripts["smoke:deploy"], "node --experimental-strip-types --test tests/api-community-deployment.test.ts tests/api-sqlite-deployment.test.ts tests/public-mvp-smoke.test.ts");

    const cliBaseUrl = await startCliServe(tempDb());
    const health = await getJson<{ ok: boolean; service: string }>(cliBaseUrl, "/api/health");
    assert.equal(health.ok, true);
    assert.equal(health.service, "agentoj-api");
    const community = await getJson<{ community: { problemId: string } }>(cliBaseUrl, "/api/problems/humaneval-001/community");
    assert.equal(community.community.problemId, "humaneval-001");

    const readme = readFileSync("README.md", "utf8");
    assert.match(readme, /GitHub Pages as the public frontend/);
    assert.match(readme, /npm run agentoj:serve/);
    assert.match(readme, /npm run smoke:deploy/);
    assert.match(readme, /localStorage\.agentojApiBase/);
    assert.match(readme, /AGENTOJ_CORS_ORIGINS/);
    assert.match(readme, /External BFF contract/);
    assert.match(readme, /\/auth\/github\/login/);
    assert.match(readme, /browser-session CSRF/);

    const app = readFileSync("web/app.js", "utf8");
    assert.match(app, /agentojApiBase/);
    assert.match(app, /\.\/data\/problems\.json/);
    const staticProblems = JSON.parse(readFileSync("web/data/problems.json", "utf8")) as Array<{ id: string }>;
    assert.equal(staticProblems.length > 0, true);
  });
});
