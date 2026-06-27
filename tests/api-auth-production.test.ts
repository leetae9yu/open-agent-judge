import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createAgentOjServer, loadAgentOjApiConfig, type AgentOjApiConfig } from "../src/index.ts";

const servers: Server[] = [];

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "agentoj-auth-")), "agentoj.sqlite");
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
    ...config,
  };
  const server = createAgentOjServer(fullConfig);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, fullConfig.host, resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  return { baseUrl: `http://${fullConfig.host}:${address.port}`, config: fullConfig };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    ),
  );
});

describe("AgentOJ production auth contract", () => {
  it("loads production auth configuration from environment without changing local defaults", () => {
    const defaults = loadAgentOjApiConfig({});
    assert.equal(defaults.authMode, "local-private");
    assert.deepEqual(defaults.allowedOrigins, []);

    const production = loadAgentOjApiConfig({
      AGENTOJ_AUTH_MODE: "production-proxy",
      AGENTOJ_PUBLIC_ORIGIN: "https://pages.example",
      AGENTOJ_TRUSTED_PROXY_SECRET: "edge-secret",
      AGENTOJ_TRUSTED_PROXY_SECRET_HEADER: "x-edge-secret",
      AGENTOJ_TRUSTED_USER_ID_HEADER: "x-edge-user",
      AGENTOJ_TRUSTED_LOGIN_HEADER: "x-edge-login",
      AGENTOJ_TRUSTED_ROLES_HEADER: "x-edge-roles",
      AGENTOJ_CSRF_HEADER: "x-csrf",
      AGENTOJ_CSRF_TOKEN: "csrf-token",
      AGENTOJ_REVIEWERS: "octocat,github:123",
      AGENTOJ_ADMIN_OPERATORS: "github:9001",
    });
    assert.equal(production.authMode, "production-proxy");
    assert.equal(production.publicOrigin, "https://pages.example");
    assert.equal(production.trustedProxySecretHeader, "x-edge-secret");
    assert.equal(production.trustedUserIdHeader, "x-edge-user");
    assert.equal(production.trustedLoginHeader, "x-edge-login");
    assert.equal(production.trustedRolesHeader, "x-edge-roles");
    assert.equal(production.csrfHeader, "x-csrf");
    assert.equal(production.csrfToken, "csrf-token");
    assert.deepEqual(production.reviewerAllowlist, ["octocat", "github:123"]);
    assert.deepEqual(production.adminOperatorAllowlist, ["github:9001"]);
  });
  it("rejects explicit invalid auth modes instead of falling back to local-private", () => {
    assert.throws(
      () => loadAgentOjApiConfig({ AGENTOJ_AUTH_MODE: "production_proxy" }),
      /Invalid AGENTOJ_AUTH_MODE: production_proxy/,
    );
  });

  it("preserves the local-private auth shim while exposing role state for /api/me", async () => {
    const { baseUrl } = await withServer();

    const anonymous = await fetch(`${baseUrl}/api/me`);
    const anonymousBody = (await anonymous.json()) as { auth: { mode: string; roles: string[]; csrfRequired: boolean }; capabilities: { canSubmit: boolean; canDiscuss: boolean; canVote: boolean; canReview: boolean; canOperateWorkers: boolean } };
    assert.equal(anonymous.status, 200);
    assert.equal(anonymousBody.auth.mode, "anonymous");
    assert.deepEqual(anonymousBody.auth.roles, []);
    assert.equal(anonymousBody.auth.csrfRequired, false);
    assert.equal(anonymousBody.capabilities.canSubmit, true);
    assert.equal(anonymousBody.capabilities.canDiscuss, true);
    assert.equal(anonymousBody.capabilities.canVote, true);
    assert.equal(anonymousBody.capabilities.canReview, false);

    const local = await fetch(`${baseUrl}/api/me`, { headers: { "x-agentoj-user": "local-user" } });
    const localBody = (await local.json()) as { auth: { mode: string; roles: string[]; isReviewer: boolean; isAdminOperator: boolean }; capabilities: { canSubmit: boolean; canDiscuss: boolean } };
    assert.equal(localBody.auth.mode, "local");
    assert.deepEqual(localBody.auth.roles, ["user"]);
    assert.equal(localBody.auth.isReviewer, false);
    assert.equal(localBody.auth.isAdminOperator, false);
    assert.equal(localBody.capabilities.canSubmit, true);
    assert.equal(localBody.capabilities.canDiscuss, true);

    const admin = await fetch(`${baseUrl}/api/me`, { headers: { authorization: "Bearer local-admin-token" } });
    const adminBody = (await admin.json()) as { auth: { mode: string; roles: string[]; isReviewer: boolean; isAdminOperator: boolean }; capabilities: { canReview: boolean; canOperateWorkers: boolean } };
    assert.equal(adminBody.auth.mode, "admin");
    assert.deepEqual(adminBody.auth.roles, ["user", "reviewer", "admin-operator"]);
    assert.equal(adminBody.auth.isReviewer, true);
    assert.equal(adminBody.auth.isAdminOperator, true);
    assert.equal(adminBody.capabilities.canReview, true);
    assert.equal(adminBody.capabilities.canOperateWorkers, true);
  });

  it("requires trusted proxy proof before accepting production identity or roles", async () => {
    const { baseUrl } = await withServer({
      authMode: "production-proxy",
      publicOrigin: "https://pages.example",
      trustedProxySecret: "edge-secret",
      csrfToken: "csrf-token",
      reviewerAllowlist: ["octocat"],
      adminOperatorAllowlist: ["github:9001"],
    });

    const spoofedLocal = await fetch(`${baseUrl}/api/me`, {
      headers: { "x-agentoj-user": "local-user", authorization: "Bearer local-admin-token" },
    });
    const spoofedLocalBody = (await spoofedLocal.json()) as { auth: { mode: string; userId: string | null; roles: string[]; csrfRequired: boolean }; capabilities: { canSubmit: boolean; canDiscuss: boolean } };
    assert.equal(spoofedLocalBody.auth.mode, "anonymous");
    assert.equal(spoofedLocalBody.auth.userId, null);
    assert.deepEqual(spoofedLocalBody.auth.roles, []);
    assert.equal(spoofedLocalBody.auth.csrfRequired, true);
    assert.equal(spoofedLocalBody.capabilities.canSubmit, false);
    assert.equal(spoofedLocalBody.capabilities.canDiscuss, false);

    const spoofedTrusted = await fetch(`${baseUrl}/api/me`, {
      headers: {
        "x-agentoj-auth-user": "123",
        "x-agentoj-auth-login": "octocat",
        "x-agentoj-auth-roles": "reviewer,admin-operator",
      },
    });
    const spoofedTrustedBody = (await spoofedTrusted.json()) as { auth: { mode: string; userId: string | null; roles: string[] } };
    assert.equal(spoofedTrustedBody.auth.mode, "anonymous");
    assert.equal(spoofedTrustedBody.auth.userId, null);
    assert.deepEqual(spoofedTrustedBody.auth.roles, []);

    const reviewer = await fetch(`${baseUrl}/api/me`, {
      headers: {
        "x-agentoj-proxy-secret": "edge-secret",
        "x-agentoj-auth-user": "123",
        "x-agentoj-auth-login": "octocat",
        "x-agentoj-auth-roles": "user,reviewer,admin-operator",
      },
    });
    const reviewerBody = (await reviewer.json()) as { auth: { mode: string; userId: string; login: string; roles: string[]; isReviewer: boolean; isAdminOperator: boolean }; capabilities: { canSubmit: boolean; canDiscuss: boolean; canReview: boolean; canOperateWorkers: boolean } };
    assert.equal(reviewerBody.auth.mode, "production-proxy");
    assert.equal(reviewerBody.auth.userId, "github:123");
    assert.equal(reviewerBody.auth.login, "octocat");
    assert.deepEqual(reviewerBody.auth.roles, ["user", "reviewer"]);
    assert.equal(reviewerBody.auth.isReviewer, true);
    assert.equal(reviewerBody.auth.isAdminOperator, false);
    assert.equal(reviewerBody.capabilities.canSubmit, true);
    assert.equal(reviewerBody.capabilities.canDiscuss, true);
    assert.equal(reviewerBody.capabilities.canReview, true);
    assert.equal(reviewerBody.capabilities.canOperateWorkers, false);

    const adminOperator = await fetch(`${baseUrl}/api/me`, {
      headers: {
        "x-agentoj-proxy-secret": "edge-secret",
        "x-agentoj-auth-user": "9001",
        "x-agentoj-auth-login": "maintainer",
        "x-agentoj-auth-roles": "admin-operator",
      },
    });
    const adminBody = (await adminOperator.json()) as { auth: { roles: string[]; isReviewer: boolean; isAdminOperator: boolean; isAdmin: boolean }; capabilities: { canReview: boolean; canOperateWorkers: boolean } };
    assert.deepEqual(adminBody.auth.roles, ["user", "admin-operator"]);
    assert.equal(adminBody.auth.isReviewer, false);
    assert.equal(adminBody.auth.isAdminOperator, true);
    assert.equal(adminBody.auth.isAdmin, true);
    assert.equal(adminBody.capabilities.canReview, false);
    assert.equal(adminBody.capabilities.canOperateWorkers, true);
  });

  it("enforces exact-origin production CORS and CSRF for state-changing requests", async () => {
    const { baseUrl } = await withServer({
      authMode: "production-proxy",
      publicOrigin: "https://pages.example",
      trustedProxySecret: "edge-secret",
      csrfToken: "csrf-token",
    });

    const allowedPreflight = await fetch(`${baseUrl}/api/submissions`, {
      method: "OPTIONS",
      headers: { origin: "https://pages.example" },
    });
    assert.equal(allowedPreflight.status, 204);
    assert.equal(allowedPreflight.headers.get("access-control-allow-origin"), "https://pages.example");
    assert.equal(allowedPreflight.headers.get("access-control-allow-credentials"), "true");
    assert.equal(allowedPreflight.headers.get("access-control-allow-headers"), "content-type,x-agentoj-csrf");
    assert.doesNotMatch(allowedPreflight.headers.get("access-control-allow-headers") ?? "", /x-agentoj-user|x-agentoj-admin-token|authorization/i);

    const deniedPreflight = await fetch(`${baseUrl}/api/submissions`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    });
    assert.equal(deniedPreflight.status, 204);
    assert.equal(deniedPreflight.headers.get("access-control-allow-origin"), null);

    const missingCsrf = await fetch(`${baseUrl}/api/submissions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentoj-proxy-secret": "edge-secret",
        "x-agentoj-auth-user": "123",
      },
      body: JSON.stringify({ problemId: "humaneval-001", patch: "diff --git a/solution.py b/solution.py" }),
    });
    assert.equal(missingCsrf.status, 403);

    const csrf = await fetch(`${baseUrl}/api/auth/csrf`);
    const csrfBody = (await csrf.json()) as { csrfRequired: boolean; csrfToken: string | null; csrfTokenSource: string };
    assert.equal(csrfBody.csrfRequired, true);
    assert.equal(csrfBody.csrfToken, null);
    assert.equal(csrfBody.csrfTokenSource, "trusted-proxy-session");

    const unauthenticatedWrite = await fetch(`${baseUrl}/api/submissions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agentoj-csrf": "csrf-token" },
      body: JSON.stringify({ problemId: "humaneval-001", patch: "diff --git a/solution.py b/solution.py" }),
    });
    assert.equal(unauthenticatedWrite.status, 401);
  });
  it("keeps production-oauth fail-closed until the in-process OAuth session path is implemented", async () => {
    const { baseUrl } = await withServer({
      authMode: "production-oauth",
      publicOrigin: "https://pages.example",
      csrfToken: "csrf-token",
    });

    const me = await fetch(`${baseUrl}/api/me`, {
      headers: { "x-agentoj-user": "local-user", authorization: "Bearer local-admin-token" },
    });
    const meBody = (await me.json()) as { auth: { mode: string; userId: string | null; roles: string[]; csrfRequired: boolean } };
    assert.equal(meBody.auth.mode, "production-oauth");
    assert.equal(meBody.auth.userId, null);
    assert.deepEqual(meBody.auth.roles, []);
    assert.equal(meBody.auth.csrfRequired, true);

    const admin = await fetch(`${baseUrl}/api/admin/health`, {
      headers: { "x-agentoj-csrf": "csrf-token", authorization: "Bearer local-admin-token" },
    });
    assert.equal(admin.status, 403);

    const submission = await fetch(`${baseUrl}/api/submissions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agentoj-csrf": "csrf-token", "x-agentoj-user": "local-user" },
      body: JSON.stringify({ problemId: "humaneval-001", patch: "diff --git a/solution.py b/solution.py" }),
    });
    assert.equal(submission.status, 401);
  });
  it("lets production reviewers approve community gates without granting worker control", async () => {
    const { baseUrl } = await withServer({
      authMode: "production-proxy",
      publicOrigin: "https://pages.example",
      trustedProxySecret: "edge-secret",
      csrfToken: "csrf-token",
      reviewerAllowlist: ["reviewer"],
      adminOperatorAllowlist: ["operator"],
    });
    const userHeaders = {
      "content-type": "application/json",
      "x-agentoj-csrf": "csrf-token",
      "x-agentoj-proxy-secret": "edge-secret",
      "x-agentoj-auth-user": "123",
      "x-agentoj-auth-login": "member",
      "x-agentoj-auth-roles": "user",
    };
    const reviewerHeaders = {
      "content-type": "application/json",
      "x-agentoj-csrf": "csrf-token",
      "x-agentoj-proxy-secret": "edge-secret",
      "x-agentoj-auth-user": "456",
      "x-agentoj-auth-login": "reviewer",
      "x-agentoj-auth-roles": "reviewer",
    };

    const suggestion = await fetch(`${baseUrl}/api/tags/suggestions`, {
      method: "POST",
      headers: userHeaders,
      body: JSON.stringify({ targetId: "humaneval-001", targetType: "problem", tag: "auth-contract" }),
    });
    const suggestionBody = (await suggestion.json()) as { tag: { id: string } };
    assert.equal(suggestion.status, 201);

    const approval = await fetch(`${baseUrl}/api/admin/tags/${encodeURIComponent(suggestionBody.tag.id)}/approve`, {
      method: "POST",
      headers: reviewerHeaders,
    });
    assert.equal(approval.status, 200);

    const worker = await fetch(`${baseUrl}/api/worker/run-next`, {
      method: "POST",
      headers: reviewerHeaders,
      body: JSON.stringify({ sandboxMode: "local" }),
    });
    assert.equal(worker.status, 403);
  });
});
