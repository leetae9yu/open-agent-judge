import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";


class FakeElement {
  innerHTML = "";
  textContent = "";
  dataset: Record<string, string> = {};
  classList = {
    add() {},
    remove() {},
    toggle() {},
  };

  addEventListener() {}
  scrollIntoView() {}
}

function responseJson(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

async function bootApp(fetchImpl: (path: string) => Promise<unknown>, search = "", initialStorage: Record<string, string> = {}) {
  const elements = new Map<string, FakeElement>();
  const element = (selector: string) => {
    if (!elements.has(selector)) elements.set(selector, new FakeElement());
    return elements.get(selector)!;
  };
  const storage = new Map<string, string>(Object.entries(initialStorage));
  const context = vm.createContext({
    console,
    fetch: fetchImpl,
    setTimeout,
    clearTimeout,
    URL,
    URLSearchParams,
    window: {
      location: { search, href: `https://pages.example/${search}` },
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    },
    document: {
      querySelector: element,
      querySelectorAll: () => [],
      getElementById: element,
    },
  });

  vm.runInContext(readFileSync("web/app.js", "utf8"), context, { filename: "web/app.js" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { context, elements, storage };
}

function staticFetch(overrides: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = {
    "./data/problems.json": [{ id: "humaneval-001", title: "Return the first element", benchmark: "humaneval", hostingMode: "hosted", tags: [] }],
    "./data/leaderboard.json": [],
    "./data/recordings.json": [],
    "./data/memory.json": [],
    "./data/registry.json": [],
    ...overrides,
  };
  return async (path: string) => {
    const body = data[path];
    if (body === undefined) return responseJson({ error: "missing" }, 404);
    return responseJson(body);
  };
}

function apiFetch(capabilities: Record<string, boolean> = {}) {
  return async (path: string) => {
    if (path.endsWith("/api/health")) return responseJson({ ok: true });
    if (path.endsWith("/api/me")) return responseJson({ auth: { isAuthenticated: Boolean(Object.keys(capabilities).length), login: "octocat" }, capabilities });
    if (path.endsWith("/api/auth/csrf")) return responseJson({ browserCsrfToken: "browser-only" });
    if (path.endsWith("/api/problems")) return responseJson({ problems: [{ id: "humaneval-001", title: "Return the first element", benchmark: "humaneval", hostingMode: "hosted", tags: [] }] });
    if (path.endsWith("/api/leaderboard")) return responseJson({ leaderboard: [] });
    if (path.endsWith("/api/recordings")) return responseJson({ recordings: [] });
    if (path.includes("/api/memory/search")) return responseJson({ results: [] });
    if (path.endsWith("/api/registry")) return responseJson({ registry: [] });
    return responseJson({ error: "unexpected" }, 404);
  };
}
describe("web UI skeleton", () => {
  it("exposes the planned AgentOJ product surfaces", () => {
    const html = readFileSync("web/index.html", "utf8");
    for (const id of ["problem-list", "problem-detail", "submission-result", "leaderboard", "discussion", "memory-search"]) {
      assert.match(html, new RegExp(`id=\"${id}\"`));
    }
    assert.match(html, /\.\/app\.js/);
  });

  it("keeps seeded fixtures in exported data and no-raw-CoT guidance in the UI", () => {
    const app = readFileSync("web/app.js", "utf8");
    const problems = JSON.parse(readFileSync("web/data/problems.json", "utf8")) as Array<{ id: string; title: string }>;
    assert.ok(problems.some((problem) => problem.id === "humaneval-001" && problem.title === "Return the first element"));
    assert.doesNotMatch(app, /Return the first element/);
    assert.match(app, /Do not post raw chain-of-thought/);
    assert.match(app, /\/api\/recordings/);
  });

  it("keeps API/admin controls hidden unless API mode and roles enable them", () => {
    const app = readFileSync("web/app.js", "utf8");
    for (const route of [
      "/api/me",
      "/api/auth/csrf",
      "/api/submissions",
      "/api/reviewer/queue",
      "/api/admin/worker/status",
      "/api/worker/run-next",
      "/api/tags/suggestions",
      "/difficulty/votes",
    ]) {
      assert.equal(app.includes(route), true, route);
    }
    for (const route of ["/auth/github/login", "/auth/logout"]) {
      assert.equal(app.includes(route), true, route);
    }
    assert.match(app, /Static GitHub Pages mode · read-only/);
    assert.match(app, /defaultApiBase = ""/);
    assert.match(app, /const apiConfigured = data\.source === "api"/);
    assert.match(app, /\$\{apiPanel\}/);
    assert.match(app, /\$\{submitPanel\}/);
    assert.match(app, /const submitPanel = canSubmit\(data\)/);
    assert.match(app, /Static GitHub Pages mode is read-only\. API login, direct submission, and admin worker controls appear only when a configured API and roles allow them\./);
    assert.match(app, /const communityPanel = communityEnabled/);
    assert.match(app, /Discussion, tags, and difficulty voting appear only when a configured API and roles allow them/);
    assert.match(app, /\.agentoj\/submission\.json/);
    assert.match(app, /The browser never stores internal proxy headers or admin tokens/);
    assert.doesNotMatch(app, /x-agentoj-auth-|x-agentoj-proxy-secret|x-agentoj-admin-token|x-agentoj-csrf/i);
    assert.match(app, /x-agentoj-browser-csrf/);
  });

  it("fails visibly instead of masking missing static public data", async () => {
    const { context, elements } = await bootApp(staticFetch({ "./data/problems.json": undefined }));
    assert.equal(context.window.__agentojData.source, "static-error");
    assert.match(elements.get("[data-problem-list]")!.innerHTML, /Public data load failed for \.\/data\/problems\.json: status 404/);
    assert.notEqual(elements.get("[data-problem-list]")!.innerHTML, "");
  });

  it("renders API, write, reviewer, and admin controls only from real capabilities", async () => {
    const staticRun = await bootApp(staticFetch());
    assert.doesNotMatch(staticRun.elements.get("[data-submission-result]")!.innerHTML, /href="[^"]*\/auth\/github\/login|data-submit-form|<h3>Admin worker<\/h3>/);
    assert.doesNotMatch(staticRun.elements.get("[data-discussion]")!.innerHTML, /data-community-form|Reviewer approval/);

    const anonymousApi = await bootApp(apiFetch(), "?api=https://api.example");
    assert.match(anonymousApi.elements.get("[data-submission-result]")!.innerHTML, /GitHub login/);
    assert.doesNotMatch(anonymousApi.elements.get("[data-submission-result]")!.innerHTML, /data-submit-form|<h3>Admin worker<\/h3>/);
    assert.doesNotMatch(anonymousApi.elements.get("[data-discussion]")!.innerHTML, /data-community-form|Reviewer approval/);

    const privilegedApi = await bootApp(apiFetch({ canSubmit: true, canDiscuss: true, canVote: true, canReview: true, canOperateWorkers: true }), "?api=https://api.example");
    assert.match(privilegedApi.elements.get("[data-submission-result]")!.innerHTML, /data-submit-form/);
    assert.match(privilegedApi.elements.get("[data-submission-result]")!.innerHTML, /Admin worker/);
    assert.match(privilegedApi.elements.get("[data-discussion]")!.innerHTML, /data-community-form/);
    assert.match(privilegedApi.elements.get("[data-discussion]")!.innerHTML, /Reviewer approval/);
  });

  it("rejects unsafe api query origins without persisting them", async () => {
    const fetched: string[] = [];
    const fetchImpl = async (path: string) => {
      fetched.push(path);
      return staticFetch()(path);
    };

    const dangerous = await bootApp(fetchImpl, "?api=http://evil.example/path?token=secret#frag", { agentojApiBase: "https://previous.example" });
    assert.equal(dangerous.context.window.__agentojData.source, "api-error");
    assert.match(dangerous.context.window.__agentojData.apiError, /paths, query strings, or fragments/);
    assert.equal(dangerous.storage.get("agentojApiBase"), undefined);
    assert.deepEqual(fetched.sort(), ["./data/leaderboard.json", "./data/memory.json", "./data/problems.json", "./data/recordings.json", "./data/registry.json"].sort());

    const credentialed = await bootApp(staticFetch(), "?api=https://user:pass@api.example");
    assert.equal(credentialed.context.window.__agentojData.source, "api-error");
    assert.match(credentialed.context.window.__agentojData.apiError, /must not include credentials/);

    const publicHttp = await bootApp(staticFetch(), "?api=http://api.example");
    assert.equal(publicHttp.context.window.__agentojData.source, "api-error");
    assert.match(publicHttp.context.window.__agentojData.apiError, /must use HTTPS/);
  });

  it("persists only safe API origins and keeps explicit api reset static", async () => {
    const safe = await bootApp(apiFetch(), "?api=http://127.0.0.1:4111/");
    assert.equal(safe.context.window.__agentojData.source, "api");
    assert.equal(safe.context.window.__agentojData.apiBase, "http://127.0.0.1:4111");
    assert.equal(safe.storage.get("agentojApiBase"), "http://127.0.0.1:4111");

    const reset = await bootApp(staticFetch(), "?api=reset", { agentojApiBase: "https://api.example" });
    assert.equal(reset.context.window.__agentojData.source, "static");
    assert.equal(reset.storage.get("agentojApiBase"), undefined);
  });

  it("uses public-facing static footer copy", () => {
    const html = readFileSync("web/index.html", "utf8");
    const css = readFileSync("web/styles.css", "utf8");

    assert.match(html, /Static by default · PR submissions · reviewed public memory/);
    assert.doesNotMatch(html, /Codex CLI|gpt-5\\.5|reasoning medium/);
    assert.doesNotMatch(css, /codex-touch-marker/);
  });
});
