import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { authMode, type AgentOjApiConfig } from "./config.ts";

export interface AgentOjDeploymentReadiness {
  ok: boolean;
  authMode: string;
  sqlite: {
    pathKind: "memory" | "file";
    persistent: boolean;
    walRecommended: true;
    backupRequiredBeforeMigration: true;
    restoreSmokeRequired: true;
    singleWriterPolicy: "node-api-process";
  };
  authBoundary: {
    selectedPublicMode: "production-proxy";
    productionOauthStatus: "fail-closed-deferred";
    exactPublicOriginConfigured: boolean;
    wildcardCorsRejected: boolean;
    trustedProxySecretConfigured: boolean;
    apiCsrfConfigured: boolean;
    deployablePublicWriteReady: boolean;
    browserReceivesDeploymentSecrets: false;
  };
  roleAllowlists: {
    reviewerEntries: number;
    adminOperatorEntries: number;
    wildcardEntriesRejected: boolean;
  };
  rollback: {
    staticPagesFallback: true;
    writeDisableMode: "stop-api-or-static-pages-read-only";
  };
  secretsExposed: false;
}

export interface SqliteBackupReceipt {
  ok: true;
  sourceKind: "file";
  backupPath: string;
  sha256: string;
  bytes: number;
}

export interface SqliteRestoreSmokeReceipt {
  ok: true;
  backupPath: string;
  integrity: "ok";
  catalogProblems: number;
}

function isMemoryPath(dbPath: string): boolean {
  return dbPath === ":memory:" || dbPath.trim().length === 0;
}

function hasWildcardEntry(values: readonly string[] | undefined): boolean {
  return Boolean(values?.some((value) => value === "*"));
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function deploymentReadiness(config: AgentOjApiConfig): AgentOjDeploymentReadiness {
  const memory = isMemoryPath(config.dbPath);
  const mode = authMode(config);
  return {
    ok:
      !memory &&
      Boolean(config.publicOrigin) &&
      !config.allowedOrigins.includes("*") &&
      (mode !== "production-proxy" || Boolean(config.trustedProxySecret)) &&
      (mode === "local-private" || Boolean(config.csrfToken)) &&
      !hasWildcardEntry(config.reviewerAllowlist) &&
      !hasWildcardEntry(config.adminOperatorAllowlist),
    authMode: mode,
    sqlite: {
      pathKind: memory ? "memory" : "file",
      persistent: !memory,
      walRecommended: true,
      backupRequiredBeforeMigration: true,
      restoreSmokeRequired: true,
      singleWriterPolicy: "node-api-process",
    },
    authBoundary: {
      selectedPublicMode: "production-proxy",
      productionOauthStatus: "fail-closed-deferred",
      exactPublicOriginConfigured: Boolean(config.publicOrigin),
      wildcardCorsRejected: !config.allowedOrigins.includes("*"),
      trustedProxySecretConfigured: Boolean(config.trustedProxySecret),
      apiCsrfConfigured: Boolean(config.csrfToken),
      deployablePublicWriteReady:
        mode === "production-proxy" &&
        !memory &&
        Boolean(config.publicOrigin) &&
        !config.allowedOrigins.includes("*") &&
        Boolean(config.trustedProxySecret) &&
        Boolean(config.csrfToken) &&
        !hasWildcardEntry(config.reviewerAllowlist) &&
        !hasWildcardEntry(config.adminOperatorAllowlist),
      browserReceivesDeploymentSecrets: false,
    },
    roleAllowlists: {
      reviewerEntries: config.reviewerAllowlist?.length ?? 0,
      adminOperatorEntries: config.adminOperatorAllowlist?.length ?? 0,
      wildcardEntriesRejected: !hasWildcardEntry(config.reviewerAllowlist) && !hasWildcardEntry(config.adminOperatorAllowlist),
    },
    rollback: {
      staticPagesFallback: true,
      writeDisableMode: "stop-api-or-static-pages-read-only",
    },
    secretsExposed: false,
  };
}

export function validateDeploymentConfig(config: AgentOjApiConfig): AgentOjDeploymentReadiness {
  const mode = authMode(config);
  const readiness = deploymentReadiness(config);
  if (mode === "local-private") return readiness;
  if (!readiness.sqlite.persistent) {
    throw new Error("Production API deployment requires a persistent SQLite file path; :memory: is local smoke only.");
  }
  if (!config.publicOrigin) {
    throw new Error("Production API deployment requires AGENTOJ_PUBLIC_ORIGIN for exact-origin CORS.");
  }
  if (config.allowedOrigins.includes("*")) {
    throw new Error("Production API deployment rejects wildcard CORS origins; configure the exact Pages/BFF origin.");
  }
  if (mode === "production-proxy" && !config.trustedProxySecret) {
    throw new Error("Production proxy deployment requires AGENTOJ_TRUSTED_PROXY_SECRET.");
  }
  if (!config.csrfToken) {
    throw new Error("Production API deployment requires AGENTOJ_CSRF_TOKEN for BFF-to-API state changes.");
  }
  if (hasWildcardEntry(config.reviewerAllowlist) || hasWildcardEntry(config.adminOperatorAllowlist)) {
    throw new Error("Production reviewer/admin allowlists must name explicit GitHub ids or logins; wildcard entries are not allowed.");
  }
  return readiness;
}

export function backupSqliteDatabase(dbPath: string, backupDir: string): SqliteBackupReceipt {
  if (isMemoryPath(dbPath)) throw new Error("Cannot back up an in-memory SQLite database.");
  if (!existsSync(dbPath)) throw new Error("SQLite database file does not exist.");
  mkdirSync(backupDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(backupDir, `${basename(dbPath)}.${timestamp}.${randomUUID()}.backup`);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`VACUUM INTO ${sqlString(backupPath)}`);
  } finally {
    db.close();
  }
  const stats = statSync(backupPath);
  return {
    ok: true,
    sourceKind: "file",
    backupPath,
    sha256: sha256File(backupPath),
    bytes: stats.size,
  };
}

export function restoreSmokeSqliteBackup(backupPath: string): SqliteRestoreSmokeReceipt {
  if (!existsSync(backupPath)) throw new Error("SQLite backup file does not exist.");
  const db = new DatabaseSync(backupPath, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (integrity.integrity_check !== "ok") throw new Error(`SQLite integrity check failed: ${integrity.integrity_check}`);
    const row = db.prepare("SELECT COUNT(*) AS count FROM problems WHERE enabled = 1").get() as { count: number };
    return { ok: true, backupPath, integrity: "ok", catalogProblems: row.count };
  } finally {
    db.close();
  }
}
