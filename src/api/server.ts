import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AgentOjApiConfig } from "./config.ts";
import { authMode, loadAgentOjApiConfig } from "./config.ts";
import { csrfHeaderName } from "./auth.ts";
import { validateDeploymentConfig } from "./deployment.ts";
import { handleAgentOjRequest } from "./routes.ts";

function originAllowed(origin: string | undefined, config: AgentOjApiConfig): boolean {
  if (!origin) return false;
  if (authMode(config) !== "local-private") return Boolean(config.publicOrigin && origin === config.publicOrigin);
  return config.allowedOrigins.includes("*") || config.allowedOrigins.includes(origin);
}

function writeJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(body, null, 2));
}

function corsHeaders(request: IncomingMessage, config: AgentOjApiConfig): Record<string, string> {
  const origin = request.headers.origin;
  if (!originAllowed(origin, config)) return {};
  const production = authMode(config) !== "local-private";
  const headers: Record<string, string> = {
    "access-control-allow-origin": origin ?? "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": production ? `content-type,${csrfHeaderName(config)}` : "content-type,authorization,x-agentoj-user,x-agentoj-admin-token",
    "vary": "origin",
  };
  if (production) headers["access-control-allow-credentials"] = "true";
  return headers;
}

export function createAgentOjServer(config: AgentOjApiConfig = loadAgentOjApiConfig()): Server {
  validateDeploymentConfig(config);
  return createServer(async (request, response) => {
    const headers = corsHeaders(request, config);
    if (request.method === "OPTIONS") {
      response.writeHead(204, headers);
      response.end();
      return;
    }

    try {
      const result = await handleAgentOjRequest(request, config);
      writeJson(response, result.status, result.body, { ...headers, ...(result.headers ?? {}) });
    } catch (error) {
      console.error("AgentOJ API internal error", error);
      writeJson(response, 500, { ok: false, code: "internal_error", error: "Internal server error." }, headers);
    }
  });
}

export function startAgentOjServer(config: AgentOjApiConfig = loadAgentOjApiConfig()): Server {
  const server = createAgentOjServer(config);
  server.listen(config.port, config.host, () => {
    const address = server.address();
    const rendered = typeof address === "object" && address ? `${address.address}:${address.port}` : String(address);
    console.error(`AgentOJ API listening on ${rendered}`);
  });
  return server;
}
