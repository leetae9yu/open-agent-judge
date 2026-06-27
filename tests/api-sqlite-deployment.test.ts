import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  backupSqliteDatabase,
  AgentOjRepository,
  createAgentOjServer,
  openAgentOjDatabase,
  restoreSmokeSqliteBackup,
  validateDeploymentConfig,
  type AgentOjApiConfig,
} from "../src/index.ts";

const servers: Server[] = [];

function tempPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "agentoj-deploy-")), name);
}

function productionConfig(dbPath: string, authMode: AgentOjApiConfig["authMode"] = "production-proxy"): AgentOjApiConfig {
  return {
    dbPath,
    host: "127.0.0.1",
    port: 0,
    allowedOrigins: [],
    localUserId: "local-user",
    runnerMode: "docker",
    authMode,
    publicOrigin: "https://pages.example",
    trustedProxySecret: "edge-secret",
    csrfToken: "csrf-token",
    adminOperatorAllowlist: ["operator"],
    reviewerAllowlist: ["reviewer"],
  };
}

async function withServer(config: AgentOjApiConfig) {
  const server = createAgentOjServer(config);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, config.host, resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  return { baseUrl: `http://${config.host}:${address.port}` };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    ),
  );
});

function adminHeaders(): Record<string, string> {
  return {
    "x-agentoj-proxy-secret": "edge-secret",
    "x-agentoj-auth-user": "operator",
    "x-agentoj-auth-login": "operator",
    "x-agentoj-auth-roles": "admin-operator",
  };
}

describe("AgentOJ SQLite deployment durability", () => {
  it("rejects in-memory SQLite for production API modes", () => {
    assert.throws(
      () => createAgentOjServer(productionConfig(":memory:")),
      /Production API deployment requires a persistent SQLite file path/,
    );
  });

  it("rejects in-memory SQLite for every public production mode while allowing local smoke", () => {
    assert.throws(
      () => createAgentOjServer(productionConfig(":memory:", "production-oauth")),
      /Production API deployment requires a persistent SQLite file path/,
    );
    const local = createAgentOjServer({
      ...productionConfig(":memory:", "local-private"),
      trustedProxySecret: undefined,
      csrfToken: undefined,
    });
    local.close();
  });

  it("fails unsafe production startup gates before serving writes", () => {
    const dbPath = tempPath("agentoj.sqlite");
    openAgentOjDatabase(dbPath).close();

    assert.throws(
      () => createAgentOjServer({ ...productionConfig(dbPath), publicOrigin: undefined }),
      /AGENTOJ_PUBLIC_ORIGIN/,
    );
    assert.throws(
      () => createAgentOjServer({ ...productionConfig(dbPath), allowedOrigins: ["*"] }),
      /wildcard CORS/,
    );
    assert.throws(
      () => createAgentOjServer({ ...productionConfig(dbPath), trustedProxySecret: undefined }),
      /AGENTOJ_TRUSTED_PROXY_SECRET/,
    );
    assert.throws(
      () => createAgentOjServer({ ...productionConfig(dbPath), csrfToken: undefined }),
      /AGENTOJ_CSRF_TOKEN/,
    );
    assert.throws(
      () => createAgentOjServer({ ...productionConfig(dbPath), adminOperatorAllowlist: ["*"] }),
      /wildcard entries/,
    );

    const oauthReadiness = validateDeploymentConfig(productionConfig(dbPath, "production-oauth"));
    assert.equal(oauthReadiness.authBoundary.productionOauthStatus, "fail-closed-deferred");
    assert.equal(oauthReadiness.authBoundary.trustedProxySecretConfigured, true);
    assert.equal(oauthReadiness.authBoundary.deployablePublicWriteReady, false);
  });

  it("creates unique SQLite backups and verifies restore smoke with WAL catalog data", () => {
    const dbPath = tempPath("agentoj.sqlite");
    const repository = AgentOjRepository.open(dbPath);
    repository.db.exec("PRAGMA journal_mode = WAL");
    repository.db
      .prepare(
        `INSERT OR IGNORE INTO problems
          (id, benchmark_id, adapter_id, upstream_task_id, title, language_framework_tags_json, hosting_mode, enabled)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("deploy-wal-problem", "humaneval", "humaneval-python", "Deploy/WAL", "Deployment WAL smoke", JSON.stringify(["python"]), "hosted", 1);
    repository.close();

    const backupDir = tempPath("backups");
    const backup = backupSqliteDatabase(dbPath, backupDir);
    const secondBackup = backupSqliteDatabase(dbPath, backupDir);
    assert.equal(backup.ok, true);
    assert.equal(backup.sourceKind, "file");
    assert.equal(backup.bytes > 0, true);
    assert.match(backup.sha256, /^[a-f0-9]{64}$/);
    assert.notEqual(backup.backupPath, secondBackup.backupPath);

    const restore = restoreSmokeSqliteBackup(backup.backupPath);
    assert.equal(restore.ok, true);
    assert.equal(restore.integrity, "ok");
    assert.equal(restore.catalogProblems >= 1, true);
  });

  it("serves secret-free deployment readiness only to admin operators", async () => {
    const dbPath = tempPath("agentoj.sqlite");
    openAgentOjDatabase(dbPath).close();
    const { baseUrl } = await withServer(productionConfig(dbPath));

    const reviewer = await fetch(`${baseUrl}/api/admin/deployment/status`, {
      headers: {
        "x-agentoj-proxy-secret": "edge-secret",
        "x-agentoj-auth-user": "reviewer",
        "x-agentoj-auth-login": "reviewer",
        "x-agentoj-auth-roles": "reviewer",
      },
    });
    assert.equal(reviewer.status, 403);

    const response = await fetch(`${baseUrl}/api/admin/deployment/status`, { headers: adminHeaders() });
    const body = (await response.json()) as {
      deployment: {
        authMode: string;
        sqlite: { pathKind: string; persistent: boolean; walRecommended: boolean; backupRequiredBeforeMigration: boolean; restoreSmokeRequired: boolean; singleWriterPolicy: string };
        authBoundary: { selectedPublicMode: string; productionOauthStatus: string; exactPublicOriginConfigured: boolean; wildcardCorsRejected: boolean; trustedProxySecretConfigured: boolean; apiCsrfConfigured: boolean; deployablePublicWriteReady: boolean; browserReceivesDeploymentSecrets: boolean };
        roleAllowlists: { reviewerEntries: number; adminOperatorEntries: number; wildcardEntriesRejected: boolean };
        rollback: { staticPagesFallback: boolean; writeDisableMode: string };
        secretsExposed: boolean;
      };
    };
    assert.equal(response.status, 200);
    assert.equal(body.deployment.authMode, "production-proxy");
    assert.deepEqual(Object.keys(body.deployment).sort(), ["authBoundary", "authMode", "ok", "roleAllowlists", "rollback", "secretsExposed", "sqlite"].sort());
    assert.deepEqual(Object.keys(body.deployment.sqlite).sort(), [
      "backupRequiredBeforeMigration",
      "pathKind",
      "persistent",
      "restoreSmokeRequired",
      "singleWriterPolicy",
      "walRecommended",
    ].sort());
    assert.deepEqual(Object.keys(body.deployment.authBoundary).sort(), [
      "apiCsrfConfigured",
      "deployablePublicWriteReady",
      "browserReceivesDeploymentSecrets",
      "exactPublicOriginConfigured",
      "productionOauthStatus",
      "selectedPublicMode",
      "trustedProxySecretConfigured",
      "wildcardCorsRejected",
    ].sort());
    assert.deepEqual(Object.keys(body.deployment.roleAllowlists).sort(), ["adminOperatorEntries", "reviewerEntries", "wildcardEntriesRejected"].sort());
    assert.deepEqual(Object.keys(body.deployment.rollback).sort(), ["staticPagesFallback", "writeDisableMode"].sort());
    assert.equal(body.deployment.sqlite.pathKind, "file");
    assert.equal(body.deployment.sqlite.persistent, true);
    assert.equal(body.deployment.sqlite.walRecommended, true);
    assert.equal(body.deployment.sqlite.singleWriterPolicy, "node-api-process");
    assert.equal(body.deployment.rollback.staticPagesFallback, true);
    assert.equal(body.deployment.rollback.writeDisableMode, "stop-api-or-static-pages-read-only");
    assert.equal(body.deployment.secretsExposed, false);
    assert.equal(body.deployment.authBoundary.selectedPublicMode, "production-proxy");
    assert.equal(body.deployment.authBoundary.productionOauthStatus, "fail-closed-deferred");
    assert.equal(body.deployment.authBoundary.exactPublicOriginConfigured, true);
    assert.equal(body.deployment.authBoundary.wildcardCorsRejected, true);
    assert.equal(body.deployment.authBoundary.trustedProxySecretConfigured, true);
    assert.equal(body.deployment.authBoundary.apiCsrfConfigured, true);
    assert.equal(body.deployment.authBoundary.deployablePublicWriteReady, true);
    assert.equal(body.deployment.authBoundary.browserReceivesDeploymentSecrets, false);
    assert.equal(body.deployment.roleAllowlists.reviewerEntries, 1);
    assert.equal(body.deployment.roleAllowlists.adminOperatorEntries, 1);
    assert.equal(body.deployment.roleAllowlists.wildcardEntriesRejected, true);
    assert.doesNotMatch(JSON.stringify(body), /agentoj\.sqlite|edge-secret|csrf-token|patch_text|stdout|stderr/i);
  });
});
