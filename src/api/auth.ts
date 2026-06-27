import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { authMode, type AgentOjApiConfig, type AgentOjAuthMode } from "./config.ts";
import { forbidden, unauthorized } from "./errors.ts";

export type AuthRole = "user" | "reviewer" | "admin-operator";

export interface AuthContext {
  userId: string | null;
  login: string | null;
  roles: AuthRole[];
  isAuthenticated: boolean;
  isReviewer: boolean;
  isAdminOperator: boolean;
  isAdmin: boolean;
  mode: "anonymous" | "local" | "admin" | AgentOjAuthMode;
  csrfRequired: boolean;
  csrfTokenEndpoint: string | null;
}

export interface AuthCapabilities {
  canSubmit: boolean;
  canDiscuss: boolean;
  canVote: boolean;
  canReview: boolean;
  canOperateWorkers: boolean;
  csrfRequired: boolean;
}

export function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function bearerToken(headers: IncomingHttpHeaders): string | undefined {
  const value = headerValue(headers, "authorization");
  if (!value?.startsWith("Bearer ")) return undefined;
  return value.slice("Bearer ".length).trim();
}

function uniqueRoles(roles: readonly string[]): AuthRole[] {
  const allowed = new Set<AuthRole>(["user", "reviewer", "admin-operator"]);
  return [...new Set(roles.map((role) => role.trim()).filter((role): role is AuthRole => allowed.has(role as AuthRole)))];
}

function matchesAllowlist(allowlist: readonly string[] | undefined, githubUserId: string, login: string | null): boolean {
  if (!allowlist || allowlist.length === 0) return false;
  const normalizedId = githubUserId.replace(/^github:/, "");
  const candidates = new Set([normalizedId, `github:${normalizedId}`]);
  if (login) candidates.add(login);
  return allowlist.some((entry) => candidates.has(entry));
}

function productionRoles(headerRoles: readonly AuthRole[], githubUserId: string, login: string | null, config: AgentOjApiConfig): AuthRole[] {
  const roles: AuthRole[] = ["user"];
  if (headerRoles.includes("reviewer") && matchesAllowlist(config.reviewerAllowlist, githubUserId, login)) {
    roles.push("reviewer");
  }
  if (headerRoles.includes("admin-operator") && matchesAllowlist(config.adminOperatorAllowlist, githubUserId, login)) {
    roles.push("admin-operator");
  }
  return roles;
}

function context(mode: AuthContext["mode"], userId: string | null, login: string | null, roles: AuthRole[], csrfRequired: boolean): AuthContext {
  const normalizedRoles = userId && !roles.includes("user") ? ["user" as const, ...roles] : roles;
  const isAdminOperator = normalizedRoles.includes("admin-operator");
  const isReviewer = normalizedRoles.includes("reviewer");
  return {
    userId,
    login,
    roles: normalizedRoles,
    isAuthenticated: Boolean(userId),
    isReviewer,
    isAdminOperator,
    isAdmin: isAdminOperator,
    mode,
    csrfRequired,
    csrfTokenEndpoint: csrfRequired ? "/api/auth/csrf" : null,
  };
}

function productionCsrfRequired(config: AgentOjApiConfig): boolean {
  return authMode(config) !== "local-private";
}
function secretMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}


function trustedProxySecretMatches(headers: IncomingHttpHeaders, config: AgentOjApiConfig): boolean {
  const secret = config.trustedProxySecret;
  if (!secret) return false;
  return secretMatches(headerValue(headers, config.trustedProxySecretHeader ?? "x-agentoj-proxy-secret"), secret);
}

function resolveProductionProxyAuth(headers: IncomingHttpHeaders, config: AgentOjApiConfig): AuthContext {
  if (!trustedProxySecretMatches(headers, config)) return context("anonymous", null, null, [], true);
  const rawUserId = headerValue(headers, config.trustedUserIdHeader ?? "x-agentoj-auth-user")?.trim();
  if (!rawUserId) return context("anonymous", null, null, [], true);
  const githubUserId = rawUserId.replace(/^github:/, "");
  const login = headerValue(headers, config.trustedLoginHeader ?? "x-agentoj-auth-login")?.trim() || null;
  const headerRoles = uniqueRoles((headerValue(headers, config.trustedRolesHeader ?? "x-agentoj-auth-roles") ?? "user").split(","));
  return context("production-proxy", `github:${githubUserId}`, login, productionRoles(headerRoles, githubUserId, login, config), true);
}

export function resolveAuth(headers: IncomingHttpHeaders, config: AgentOjApiConfig): AuthContext {
  const mode = authMode(config);
  if (mode === "production-proxy") return resolveProductionProxyAuth(headers, config);
  if (mode === "production-oauth") return context("production-oauth", null, null, [], true);

  const explicitAdmin = headerValue(headers, "x-agentoj-admin-token") ?? bearerToken(headers);
  if (config.adminToken && secretMatches(explicitAdmin, config.adminToken)) {
    return context("admin", "admin", "admin", ["user", "reviewer", "admin-operator"], false);
  }

  const localUser = headerValue(headers, "x-agentoj-user");
  if (localUser === config.localUserId) {
    return context("local", config.localUserId, config.localUserId, ["user"], false);
  }

  return context("anonymous", null, null, [], false);
}

export function authCapabilities(auth: AuthContext, config: AgentOjApiConfig): AuthCapabilities {
  const localPrivate = authMode(config) === "local-private";
  const userWritable = localPrivate || auth.isAuthenticated;
  return {
    canSubmit: userWritable,
    canDiscuss: userWritable,
    canVote: userWritable,
    canReview: auth.isReviewer,
    canOperateWorkers: auth.isAdminOperator,
    csrfRequired: auth.csrfRequired,
  };
}

export function csrfHeaderName(config: AgentOjApiConfig): string {
  return config.csrfHeader ?? "x-agentoj-csrf";
}

export function csrfRequiredForRequest(method: string, config: AgentOjApiConfig): boolean {
  return productionCsrfRequired(config) && !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

export function csrfValid(headers: IncomingHttpHeaders, config: AgentOjApiConfig): boolean {
  const token = config.csrfToken;
  if (!token) return false;
  return secretMatches(headerValue(headers, csrfHeaderName(config)), token);
}

export function requireUser(auth: AuthContext): string {
  if (!auth.userId) throw unauthorized();
  return auth.userId;
}

export function requireReviewer(auth: AuthContext): string {
  if (!auth.isReviewer || !auth.userId) throw forbidden("Reviewer credentials required.");
  return auth.userId;
}

export function requireAdmin(auth: AuthContext): void {
  if (!auth.isAdminOperator) throw forbidden();
}
