import type { IncomingMessage } from "node:http";
import { authMode, type AgentOjApiConfig } from "./config.ts";
import { authCapabilities, csrfRequiredForRequest, csrfValid, requireAdmin, requireReviewer, requireUser, resolveAuth } from "./auth.ts";
import { deploymentReadiness } from "./deployment.ts";
import { ApiError, badRequest, notFound } from "./errors.ts";
import { exportRecordingMarkdownFromSqlite } from "../storage/sqlite-store.ts";
import { withAgentOjRepository } from "./repository.ts";

export interface ApiResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

function routePath(request: IncomingMessage, config: AgentOjApiConfig): URL {
  return new URL(request.url ?? "/", config.publicBaseUrl ?? `http://${config.host}:${config.port}`);
}
export const AGENTOJ_API_JSON_BODY_LIMIT_BYTES = 1024 * 1024;

function jsonBodyTooLarge(): ApiError {
  return new ApiError(413, "Request JSON body is too large.", "payload_too_large");
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const declaredLength = request.headers["content-length"];
  if (typeof declaredLength === "string" && Number(declaredLength) > AGENTOJ_API_JSON_BODY_LIMIT_BYTES) {
    throw jsonBodyTooLarge();
  }

  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    receivedBytes += buffer.byteLength;
    if (receivedBytes > AGENTOJ_API_JSON_BODY_LIMIT_BYTES) {
      throw jsonBodyTooLarge();
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  if (receivedBytes > AGENTOJ_API_JSON_BODY_LIMIT_BYTES) throw jsonBodyTooLarge();
  try {
    const parsed = JSON.parse(Buffer.concat(chunks, receivedBytes).toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body must be an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw badRequest("Request body must be a JSON object.");
  }
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0) throw badRequest(`Missing required field: ${key}.`);
  if (Buffer.byteLength(value, "utf8") >= AGENTOJ_API_JSON_BODY_LIMIT_BYTES) throw jsonBodyTooLarge();
  return value;
}

function integerField(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isInteger(value)) throw badRequest(`Missing required integer field: ${key}.`);
  return value;
}

export async function handleAgentOjRequest(request: IncomingMessage, config: AgentOjApiConfig): Promise<ApiResponse> {
  const url = routePath(request, config);
  const auth = resolveAuth(request.headers, config);
  const method = request.method ?? "GET";
  const mode = authMode(config);

  try {
    if (csrfRequiredForRequest(method, config) && !csrfValid(request.headers, config)) {
      return { status: 403, body: { ok: false, code: "csrf_required", error: "Valid CSRF token required." } };
    }

    if (method === "GET" && url.pathname === "/api/auth/csrf") {
      return { status: 200, body: { ok: true, csrfRequired: auth.csrfRequired, csrfToken: null, csrfTokenSource: auth.csrfRequired ? "trusted-proxy-session" : "not-required" } };
    }

    if (method === "GET" && url.pathname === "/api/health") {
      return withAgentOjRepository(config.dbPath, (repository) => ({
        status: 200,
        body: {
          ...repository.health(),
          service: "agentoj-api",
          runnerMode: config.runnerMode,
          authMode: mode,
        },
      }));
    }

    if (method === "GET" && url.pathname === "/api/me") {
      return { status: 200, body: { ok: true, auth, capabilities: authCapabilities(auth, config) } };
    }

    if (method === "GET" && url.pathname === "/api/admin/health") {
      requireAdmin(auth);
      return { status: 200, body: { ok: true, admin: true } };
    }
    if (method === "GET" && url.pathname === "/api/admin/deployment/status") {
      requireAdmin(auth);
      return { status: 200, body: { ok: true, deployment: deploymentReadiness(config) } };
    }
    if (method === "POST" && url.pathname === "/api/submissions") {
      const body = await readJsonBody(request);
      const visibility = body.visibility;
      if (
        visibility !== undefined &&
        visibility !== "private" &&
        visibility !== "public-summary" &&
        visibility !== "public-full"
      ) {
        throw badRequest("Invalid visibility.");
      }
      return withAgentOjRepository(config.dbPath, (repository) => ({
        status: 202,
        body: {
          ok: true,
          submission: repository.submitPatch({
            problemId: stringField(body, "problemId"),
            patch: stringField(body, "patch"),
            userId: mode !== "local-private" ? requireUser(auth) : auth.userId ?? "anonymous",
            visibility,
          }),
        },
      }));
    }
    const submissionStatusMatch = url.pathname.match(/^\/api\/submissions\/([^/]+)\/status$/);
    if (method === "GET" && submissionStatusMatch) {
      let submissionId: string;
      try {
        submissionId = decodeURIComponent(submissionStatusMatch[1]);
      } catch {
        throw badRequest("Invalid submission id encoding.");
      }
      const viewerUserId = mode !== "local-private" && !auth.isReviewer ? requireUser(auth) : undefined;
      return withAgentOjRepository(config.dbPath, (repository) => ({
        status: 200,
        body: { ok: true, status: repository.getSubmissionStatus(submissionId, viewerUserId) },
      }));
    }

    if (method === "GET" && url.pathname === "/api/reviewer/queue") {
      requireReviewer(auth);
      return withAgentOjRepository(config.dbPath, (repository) => ({
        status: 200,
        body: { ok: true, queue: repository.getReviewerQueue() },
      }));
    }

    if (method === "GET" && url.pathname === "/api/admin/worker/status") {
      requireAdmin(auth);
      return withAgentOjRepository(config.dbPath, (repository) => ({
        status: 200,
        body: { ok: true, worker: repository.getWorkerStatus() },
      }));
    }


    if (method === "POST" && url.pathname === "/api/worker/run-next") {
      requireAdmin(auth);
      const body = await readJsonBody(request);
      if (body.sandboxMode !== undefined && body.sandboxMode !== "local" && body.sandboxMode !== "docker") {
        throw badRequest("Invalid sandboxMode.");
      }
      const sandboxMode = body.sandboxMode === "docker" || (body.sandboxMode === undefined && config.runnerMode === "docker") ? "docker" : "local";
      if (mode !== "local-private" && sandboxMode !== "docker") throw badRequest("Production workers require docker sandbox.");
      return withAgentOjRepository(config.dbPath, (repository) => ({
        status: 200,
        body: { ok: true, result: repository.runNextQueuedJob(sandboxMode) },
      }));
    }
    if (method === "POST" && url.pathname === "/api/admin/recordings/from-job") {
      requireAdmin(auth);
      const body = await readJsonBody(request);
      return withAgentOjRepository(config.dbPath, (repository) => ({
        status: 201,
        body: {
          ok: true,
          recording: repository.createPendingRecordingFromJob({
            jobId: stringField(body, "jobId"),
            summary: stringField(body, "summary"),
            rootCause: stringField(body, "rootCause"),
            fixDescription: stringField(body, "fixDescription"),
          }),
        },
      }));
    }

    const recordingApprovalMatch = url.pathname.match(/^\/api\/admin\/recordings\/([^/]+)\/approve$/);
    if (method === "POST" && recordingApprovalMatch) {
      requireReviewer(auth);
      let recordingId: string;
      try {
        recordingId = decodeURIComponent(recordingApprovalMatch[1]);
      } catch {
        throw badRequest("Invalid recording id encoding.");
      }
      return withAgentOjRepository(config.dbPath, (repository) => ({
        status: 200,
        body: {
          ok: true,
          memory: repository.approveRecordingForPublicMemory(recordingId, auth.userId ?? "admin"),
        },
      }));
    }

    if (method === "GET" && url.pathname === "/api/problems") {
      return withAgentOjRepository(config.dbPath, (repository) => ({
        status: 200,
        body: { ok: true, problems: repository.listProblems() },
      }));
    }

    const problemMatch = url.pathname.match(/^\/api\/problems\/([^/]+)$/);
    if (method === "GET" && problemMatch) {
      let problemId: string;
      try {
        problemId = decodeURIComponent(problemMatch[1]);
      } catch {
        throw badRequest("Invalid problem id encoding.");
      }
      return withAgentOjRepository(config.dbPath, (repository) => ({
        status: 200,
        body: { ok: true, problem: repository.getProblem(problemId) },
      }));
    }
    const communityMatch = url.pathname.match(/^\/api\/problems\/([^/]+)\/community$/);
    if (method === "GET" && communityMatch) {
      let problemId: string;
      try {
        problemId = decodeURIComponent(communityMatch[1]);
      } catch {
        throw badRequest("Invalid problem id encoding.");
      }
      return withAgentOjRepository(config.dbPath, (repository) => ({
        status: 200,
        body: { ok: true, community: repository.getProblemCommunity(problemId) },
      }));
    }

    const discussionMatch = url.pathname.match(/^\/api\/problems\/([^/]+)\/discussions$/);
    if (method === "POST" && discussionMatch) {
      const userId = mode !== "local-private" ? requireUser(auth) : auth.userId ?? "anonymous";
      let problemId: string;
      try {
        problemId = decodeURIComponent(discussionMatch[1]);
      } catch {
        throw badRequest("Invalid problem id encoding.");
      }
      const body = await readJsonBody(request);
      return withAgentOjRepository(config.dbPath, (repository) => ({
        status: 201,
        body: {
          ok: true,
          discussion: repository.createDiscussionPost({
            problemId,
            authorId: userId,
            markdown: stringField(body, "markdown"),
          }),
        },
      }));
    }

    const difficultyVoteMatch = url.pathname.match(/^\/api\/problems\/([^/]+)\/difficulty\/votes$/);
    if (method === "POST" && difficultyVoteMatch) {
      const userId = mode !== "local-private" ? requireUser(auth) : auth.userId ?? "anonymous";
      let problemId: string;
      try {
        problemId = decodeURIComponent(difficultyVoteMatch[1]);
      } catch {
        throw badRequest("Invalid problem id encoding.");
      }
      const body = await readJsonBody(request);
      return withAgentOjRepository(config.dbPath, (repository) => ({
        status: 201,
        body: {
          ok: true,
          vote: repository.voteDifficulty({
            problemId,
            voterId: userId,
            value: integerField(body, "value"),
          }),
        },
      }));
    }

    const difficultyApproveMatch = url.pathname.match(/^\/api\/admin\/problems\/([^/]+)\/difficulty\/approve$/);
    if (method === "POST" && difficultyApproveMatch) {
      requireReviewer(auth);
      let problemId: string;
      try {
        problemId = decodeURIComponent(difficultyApproveMatch[1]);
      } catch {
        throw badRequest("Invalid problem id encoding.");
      }
      return withAgentOjRepository(config.dbPath, (repository) => ({
        status: 200,
        body: { ok: true, difficulty: repository.approveDifficulty(problemId, auth.userId ?? "admin") },
      }));
    }

    if (method === "POST" && url.pathname === "/api/tags/suggestions") {
      const userId = mode !== "local-private" ? requireUser(auth) : auth.userId ?? "anonymous";
      const body = await readJsonBody(request);
      const targetType = stringField(body, "targetType");
      if (targetType !== "problem" && targetType !== "recording") throw badRequest("Invalid tag targetType.");
      return withAgentOjRepository(config.dbPath, (repository) => ({
        status: 201,
        body: {
          ok: true,
          tag: repository.suggestTag({
            targetId: stringField(body, "targetId"),
            targetType,
            tag: stringField(body, "tag"),
            suggestedBy: userId,
          }),
        },
      }));
    }

    const tagApproveMatch = url.pathname.match(/^\/api\/admin\/tags\/([^/]+)\/approve$/);
    if (method === "POST" && tagApproveMatch) {
      requireReviewer(auth);
      let tagId: string;
      try {
        tagId = decodeURIComponent(tagApproveMatch[1]);
      } catch {
        throw badRequest("Invalid tag id encoding.");
      }
      return withAgentOjRepository(config.dbPath, (repository) => ({
        status: 200,
        body: { ok: true, tag: repository.approveTagSuggestion(tagId, auth.userId ?? "admin") },
      }));
    }

    if (method === "GET" && url.pathname === "/api/registry") {
      return withAgentOjRepository(config.dbPath, (repository) => ({
        status: 200,
        body: { ok: true, registry: repository.listRegistry() },
      }));
    }

    if (method === "GET" && url.pathname === "/api/leaderboard") {
      return withAgentOjRepository(config.dbPath, (repository) => ({
        status: 200,
        body: { ok: true, leaderboard: repository.listLeaderboard() },
      }));
    }

    if (method === "GET" && url.pathname === "/api/recordings") {
      return withAgentOjRepository(config.dbPath, (repository) => ({
        status: 200,
        body: { ok: true, recordings: repository.listPublicRecordings() },
      }));
    }

    const recordingExportMatch = url.pathname.match(/^\/api\/recordings\/([^/]+)\/export$/);
    if (method === "GET" && recordingExportMatch) {
      let recordingId: string;
      try {
        recordingId = decodeURIComponent(recordingExportMatch[1]);
      } catch {
        throw badRequest("Invalid recording id encoding.");
      }
      return withAgentOjRepository(config.dbPath, (repository) => {
        repository.getPublicRecording(recordingId);
        return {
          status: 200,
          body: { ok: true, recordingId, markdown: exportRecordingMarkdownFromSqlite(config.dbPath, recordingId) },
        };
      });
    }

    const recordingMatch = url.pathname.match(/^\/api\/recordings\/([^/]+)$/);
    if (method === "GET" && recordingMatch) {
      let recordingId: string;
      try {
        recordingId = decodeURIComponent(recordingMatch[1]);
      } catch {
        throw badRequest("Invalid recording id encoding.");
      }
      return withAgentOjRepository(config.dbPath, (repository) => ({
        status: 200,
        body: { ok: true, recording: repository.getPublicRecording(recordingId) },
      }));
    }

    if (method === "GET" && url.pathname === "/api/memory/search") {
      const errorSignature = url.searchParams.get("errorSignature") ?? url.searchParams.get("error");
      const languageFramework = url.searchParams.get("languageFramework") ?? url.searchParams.get("framework");
      if (!errorSignature || !languageFramework) {
        throw badRequest("memory search requires errorSignature and languageFramework.");
      }
      return withAgentOjRepository(config.dbPath, (repository) => ({
        status: 200,
        body: {
          ok: true,
          results: repository.searchPublicMemory({ errorSignature, languageFramework }),
        },
      }));
    }

    throw notFound(`No route for ${method} ${url.pathname}`);
  } catch (error) {
    if (error instanceof ApiError) {
      const headers = error.status === 413 ? { connection: "close" } : undefined;
      return { status: error.status, headers, body: { ok: false, code: error.code, error: error.message } };
    }
    throw error;
  }
}
