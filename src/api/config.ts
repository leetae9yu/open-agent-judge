export type AgentOjAuthMode = "local-private" | "production-proxy" | "production-oauth";

export interface AgentOjApiConfig {
  dbPath: string;
  host: string;
  port: number;
  allowedOrigins: string[];
  localUserId: string;
  adminToken?: string;
  publicBaseUrl?: string;
  runnerMode: "local" | "docker";
  authMode?: AgentOjAuthMode;
  publicOrigin?: string;
  trustedProxySecret?: string;
  trustedProxySecretHeader?: string;
  trustedUserIdHeader?: string;
  trustedLoginHeader?: string;
  trustedRolesHeader?: string;
  csrfHeader?: string;
  csrfToken?: string;
  reviewerAllowlist?: string[];
  adminOperatorAllowlist?: string[];
}

function splitCsv(value: string | undefined): string[] {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

export function authMode(config: AgentOjApiConfig): AgentOjAuthMode {
  return config.authMode ?? "local-private";
}

function parseAuthMode(value: string | undefined): AgentOjAuthMode {
  if (value === undefined || value === "") return "local-private";
  if (value === "local-private" || value === "production-proxy" || value === "production-oauth") return value;
  throw new Error(`Invalid AGENTOJ_AUTH_MODE: ${value}`);
}

export function loadAgentOjApiConfig(env: NodeJS.ProcessEnv = process.env): AgentOjApiConfig {
  const port = Number.parseInt(env.AGENTOJ_PORT ?? "3000", 10);
  const configuredAuthMode = parseAuthMode(env.AGENTOJ_AUTH_MODE);
  const publicOrigin = env.AGENTOJ_PUBLIC_ORIGIN;
  return {
    dbPath: env.AGENTOJ_DB ?? ":memory:",
    host: env.AGENTOJ_HOST ?? "127.0.0.1",
    port: Number.isFinite(port) ? port : 3000,
    allowedOrigins: splitCsv(env.AGENTOJ_CORS_ORIGINS),
    localUserId: env.AGENTOJ_LOCAL_USER ?? "local-user",
    adminToken: env.AGENTOJ_ADMIN_TOKEN,
    publicBaseUrl: env.AGENTOJ_PUBLIC_BASE_URL,
    runnerMode: env.AGENTOJ_RUNNER_MODE === "docker" ? "docker" : "local",
    authMode: configuredAuthMode,
    publicOrigin,
    trustedProxySecret: env.AGENTOJ_TRUSTED_PROXY_SECRET,
    trustedProxySecretHeader: env.AGENTOJ_TRUSTED_PROXY_SECRET_HEADER ?? "x-agentoj-proxy-secret",
    trustedUserIdHeader: env.AGENTOJ_TRUSTED_USER_ID_HEADER ?? "x-agentoj-auth-user",
    trustedLoginHeader: env.AGENTOJ_TRUSTED_LOGIN_HEADER ?? "x-agentoj-auth-login",
    trustedRolesHeader: env.AGENTOJ_TRUSTED_ROLES_HEADER ?? "x-agentoj-auth-roles",
    csrfHeader: env.AGENTOJ_CSRF_HEADER ?? "x-agentoj-csrf",
    csrfToken: env.AGENTOJ_CSRF_TOKEN,
    reviewerAllowlist: splitCsv(env.AGENTOJ_REVIEWERS),
    adminOperatorAllowlist: splitCsv(env.AGENTOJ_ADMIN_OPERATORS),
  };
}
