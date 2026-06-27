const fallbackData = {
  problems: [],
  leaderboard: [],
  recordings: [],
  memory: [],
  registry: [],
};
const defaultApiBase = "";
const apiBaseStorageKey = "agentojApiBase";

function apiBaseRejection(message) {
  return { apiBase: "", apiError: message };
}

function isPrivateDevHostname(hostname) {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]" || normalized.endsWith(".localhost") || normalized.endsWith(".local")) return true;
  if (/^127\./.test(normalized) || /^10\./.test(normalized) || /^192\.168\./.test(normalized)) return true;
  const private172 = normalized.match(/^172\.(\d{1,2})\./);
  return Boolean(private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31);
}

function normalizeApiBase(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return apiBaseRejection("empty API origin");
  let url;
  try {
    url = new URL(raw);
  } catch {
    return apiBaseRejection("API origin must be an absolute http(s) origin");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return apiBaseRejection("API origin must use http(s)");
  if (url.username || url.password) return apiBaseRejection("API origin must not include credentials");
  if (url.pathname !== "/" || url.search || url.hash) return apiBaseRejection("API origin must not include paths, query strings, or fragments");
  if (url.protocol !== "https:" && !isPrivateDevHostname(url.hostname)) return apiBaseRejection("public API origins must use HTTPS");
  return { apiBase: url.origin };
}

function configuredApiBase() {
  const params = new URLSearchParams(window.location.search);
  if (params.has("api")) {
    const fromQuery = params.get("api") ?? "";
    if (fromQuery.trim() === "" || fromQuery.trim().toLowerCase() === "reset") {
      window.localStorage?.removeItem(apiBaseStorageKey);
      return { apiBase: defaultApiBase };
    }
    const normalized = normalizeApiBase(fromQuery);
    if (normalized.apiBase) {
      window.localStorage?.setItem(apiBaseStorageKey, normalized.apiBase);
      return normalized;
    }
    window.localStorage?.removeItem(apiBaseStorageKey);
    return normalized;
  }

  const stored = window.localStorage?.getItem(apiBaseStorageKey);
  if (!stored) return { apiBase: defaultApiBase };
  const normalized = normalizeApiBase(stored);
  if (!normalized.apiBase) window.localStorage?.removeItem(apiBaseStorageKey);
  return normalized;
}

function publicDataError(path, detail) {
  return new Error(`Public data load failed for ${path}: ${detail}`);
}

async function loadJson(path) {
  let response;
  try {
    response = await fetch(path);
  } catch {
    throw publicDataError(path, "network");
  }
  if (!response.ok) {
    throw publicDataError(path, `status ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw publicDataError(path, "invalid json");
  }
}

async function fetchJsonStrict(path, options = {}) {
  const response = await fetch(path, { credentials: "include", ...options });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = body?.error || body?.code || `Failed to load ${path}`;
    throw new Error(message);
  }
  return body;
}

async function loadApiData(apiBase) {
  const [me, csrf, problems, leaderboard, recordings, memory, registry] = await Promise.all([
    fetchJsonStrict(`${apiBase}/api/me`),
    fetchJsonStrict(`${apiBase}/api/auth/csrf`),
    fetchJsonStrict(`${apiBase}/api/problems`),
    fetchJsonStrict(`${apiBase}/api/leaderboard`),
    fetchJsonStrict(`${apiBase}/api/recordings`),
    fetchJsonStrict(`${apiBase}/api/memory/search?errorSignature=target%20edge%20case&languageFramework=python`),
    fetchJsonStrict(`${apiBase}/api/registry`),
  ]);

  if (!Array.isArray(problems.problems) || !Array.isArray(leaderboard.leaderboard) || !Array.isArray(recordings.recordings) || !Array.isArray(memory.results) || !Array.isArray(registry.registry)) {
    throw new Error("Invalid AgentOJ API response shape");
  }

  return {
    problems: problems.problems,
    leaderboard: leaderboard.leaderboard,
    recordings: recordings.recordings,
    memory: memory.results,
    registry: registry.registry,
    auth: me.auth,
    capabilities: me.capabilities || {},
    csrf,
    source: "api",
  };
}

async function loadStaticData() {
  const [problems, leaderboard, recordings, memory, registry] = await Promise.all([
    loadJson("./data/problems.json"),
    loadJson("./data/leaderboard.json"),
    loadJson("./data/recordings.json"),
    loadJson("./data/memory.json"),
    loadJson("./data/registry.json"),
  ]);
  return { problems, leaderboard, recordings, memory, registry, source: "static" };
}

async function loadData() {
  const apiConfig = configuredApiBase();
  const apiBase = apiConfig.apiBase;
  if (!apiBase) {
    const data = await loadStaticData();
    return apiConfig.apiError ? { ...data, source: "api-error", apiBase: "static fallback", apiError: apiConfig.apiError } : data;
  }

  try {
    const health = await fetch(`${apiBase}/api/health`, { credentials: "include" });
    if (!health.ok) throw new Error("API health check failed");
    const data = await loadApiData(apiBase);
    return { ...data, apiBase };
  } catch (error) {
    const data = await loadStaticData();
    return { ...data, source: "api-error", apiBase, apiError: error.message };
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function tags(values) {
  return values.map((value) => `<span class="tag">${escapeHtml(value)}</span>`).join(" ");
}

function problemOptions(data) {
  return data.problems.map((problem) => `<option value="${escapeHtml(problem.id)}">${escapeHtml(problem.id)} · ${escapeHtml(problem.title)}</option>`).join("");
}

function roleLine(data) {
  if (data.source === "api-error") return `API 오류 · ${escapeHtml(data.apiBase)} · ${escapeHtml(data.apiError)}`;
  if (data.source !== "api") return "정적 GitHub Pages 모드 · 읽기 전용";
  const auth = data.auth || {};
  const roles = [auth.isAuthenticated ? "user" : "anonymous", data.capabilities?.canReview ? "reviewer" : "", data.capabilities?.canOperateWorkers ? "admin-operator" : ""].filter(Boolean).join(" / ");
  return `API 모드 · ${escapeHtml(roles || "anonymous")}`;
}



function canSubmit(data) {
  return data.source === "api" && Boolean(data.capabilities?.canSubmit);
}

function canDiscuss(data) {
  return data.source === "api" && Boolean(data.capabilities?.canDiscuss);
}

function canVote(data) {
  return data.source === "api" && Boolean(data.capabilities?.canVote);
}

function isReviewer(data) {
  return data.source === "api" && Boolean(data.capabilities?.canReview || data.auth?.isReviewer);
}

function isAdmin(data) {
  return data.source === "api" && Boolean(data.capabilities?.canOperateWorkers || data.auth?.isAdminOperator);
}

function bffUrl(data, path) {
  if (data.source !== "api" || !data.apiBase) return "#";
  const url = new URL(path, `${data.apiBase}/`);
  url.searchParams.set("returnTo", window.location.href);
  return url.toString();
}

function apiHeaders(data) {
  const headers = { "content-type": "application/json" };
  if (data.csrf?.browserCsrfToken) headers["x-agentoj-browser-csrf"] = data.csrf.browserCsrfToken;
  return headers;
}

async function apiRequest(data, path, { method = "POST", body } = {}) {
  if (data.source !== "api") throw new Error("API mode is required.");
  return fetchJsonStrict(`${data.apiBase}${path}`, {
    method,
    headers: apiHeaders(data),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function setStatus(selector, message, kind = "pending") {
  const el = document.querySelector(selector);
  if (!el) return;
  el.innerHTML = `<span class="result-badge result-badge--${escapeHtml(kind)}">${escapeHtml(message)}</span>`;
}

// ── Stats bar ───────────────────────────────────────

function renderStats(data) {
  const el = document.querySelector("[data-stats]");
  if (!el) return;
  el.innerHTML = [
    `<div class="stat"><span class="stat-value">${data.problems.length}</span><span class="stat-label">문제</span></div>`,
    `<div class="stat"><span class="stat-value">${data.leaderboard.length}</span><span class="stat-label">제출</span></div>`,
    `<div class="stat"><span class="stat-value">${data.recordings.length}</span><span class="stat-label">녹화</span></div>`,
    `<div class="stat"><span class="stat-value">${data.memory.length}</span><span class="stat-label">메모리</span></div>`,
    `<div class="stat"><span class="stat-value">${data.source === "api" ? "API" : "JSON"}</span><span class="stat-label">데이터</span></div>`,
  ].join("");
}

// ── Problems table ──────────────────────────────────

function renderProblems(data) {
  document.querySelector("[data-problem-list]").innerHTML = data.problems
    .map(
      (problem, i) => `
        <tr data-problem-id="${escapeHtml(problem.id)}">
          <td class="problem-no">${i + 1}</td>
          <td><span class="problem-title">${escapeHtml(problem.title)}</span></td>
          <td class="problem-source">${escapeHtml(problem.benchmark ?? problem.benchmarkId)}</td>
          <td class="problem-mode">${escapeHtml(problem.hostingMode)}</td>
          <td class="col-tags-cell">${tags(problem.tags ?? [])}</td>
        </tr>`,
    )
    .join("");
}

// ── Problem detail ──────────────────────────────────

function renderProblemDetail(data, problem = data.problems[0]) {
  if (!problem) return;
  document.querySelector("[data-problem-detail]").innerHTML = `
    <h3>${escapeHtml(problem.title)}</h3>
    <div class="detail-row"><span class="detail-label">문제 번호</span><span class="detail-value">${escapeHtml(problem.id)}</span></div>
    <div class="detail-row"><span class="detail-label">출처</span><span class="detail-value">${escapeHtml(problem.benchmark ?? problem.benchmarkId)}</span></div>
    <div class="detail-row"><span class="detail-label">유형</span><span class="detail-value">${escapeHtml(problem.hostingMode)}</span></div>
    <div class="detail-row"><span class="detail-label">태그</span><span class="detail-value">${tags(problem.tags ?? [])}</span></div>
    <p class="hint">${data.source === "api" ? "Optional API demo mode is connected for private/local operations." : "Public GitHub Pages is read-only. Submit by opening a GitHub PR with .agentoj/submission.json and .agentoj/submission.patch."}</p>
  `;
}

// ── Submission and worker status ────────────────────

function renderSubmissionResult(data) {
  const recording = data.recordings[0];
  const apiConfigured = data.source === "api";
  const apiPanel = apiConfigured
    ? `<section class="api-panel">
        <h3>Optional API demo</h3>
        <div class="detail-row"><span class="detail-label">모드</span><span class="detail-value">${roleLine(data)}</span></div>
        <div class="detail-row"><span class="detail-label">세션</span><span class="detail-value">${data.auth?.isAuthenticated ? escapeHtml(data.auth.login || data.auth.userId || "authenticated") : "anonymous"}</span></div>
        <div class="button-row">
          <a class="button-link" href="${escapeHtml(bffUrl(data, "/auth/github/login"))}">GitHub 로그인</a>
          <a class="button-link button-link--secondary" href="${escapeHtml(bffUrl(data, "/auth/logout"))}">로그아웃</a>
        </div>
        <p class="hint">브라우저는 내부 프록시 헤더나 관리자 토큰을 저장하지 않습니다. 공개 쓰기는 GitHub OAuth/BFF 세션과 CSRF 정책 뒤에서만 동작합니다.</p>
      </section>`
    : "";

  const submitPanel = canSubmit(data)
    ? `<section class="api-panel">
        <h3>패치 제출</h3>
        <form data-submit-form class="form-grid">
          <label>문제<select name="problemId">${problemOptions(data)}</select></label>
          <label>unified diff<textarea name="patch" rows="8" placeholder="diff --git a/solution.py b/solution.py"></textarea></label>
          <label>공개 범위<select name="visibility"><option value="private">private</option><option value="public-summary">public-summary</option><option value="public-full">public-full</option></select></label>
          <button type="submit">제출</button>
        </form>
        <div class="action-status" data-submit-status>제출 대기 중</div>
        <div class="action-status" data-worker-status></div>
      </section>`
    : "";

  document.querySelector("[data-submission-result]").innerHTML = `
    <section class="api-panel">
      <h3>GitHub PR 제출</h3>
      <p class="hint">기본 제출 경로는 공개 GitHub PR입니다. PR에는 <code>.agentoj/submission.json</code> envelope와 <code>.agentoj/submission.patch</code> unified diff만 포함하고, judge 결과는 sanitized summary로만 공개됩니다.</p>
      <p class="hint">정적 GitHub Pages 모드는 읽기 전용이며 API 로그인, 직접 제출, 관리자 워커 컨트롤은 구성된 API와 권한이 있을 때만 표시됩니다.</p>
    </section>

    ${apiPanel}
    ${submitPanel}

    <section class="api-panel">
      <h3>최근 공개 결과</h3>
      ${recording
        ? `<div class="detail-row"><span class="detail-label">결과</span><span class="detail-value"><span class="result-badge result-badge--pass">맞았습니다</span></span></div><div class="detail-row"><span class="detail-label">메모리</span><span class="detail-value"><code>${escapeHtml(recording.publicSlug)}</code></span></div><p class="hint">${escapeHtml(recording.summary)}</p>`
        : `<p class="hint">승인된 공개 recording이 아직 없습니다.</p>`}
    </section>

    ${isAdmin(data) ? `<section class="api-panel"><h3>관리자 워커</h3><button data-worker-refresh>워커 상태</button> <button data-run-worker>다음 작업 실행</button><div class="action-status" data-admin-worker-status></div></section>` : ""}
  `;
}

async function renderOwnSubmissionStatus(data, submissionId) {
  const result = await apiRequest(data, `/api/submissions/${encodeURIComponent(submissionId)}/status`, { method: "GET" });
  const status = result.status;
  const verdict = status.result?.passFail || status.status;
  document.querySelector("[data-worker-status]").innerHTML = `
    <div class="detail-row"><span class="detail-label">제출</span><span class="detail-value"><code>${escapeHtml(status.submissionId)}</code></span></div>
    <div class="detail-row"><span class="detail-label">상태</span><span class="detail-value">${escapeHtml(status.status)}</span></div>
    <div class="detail-row"><span class="detail-label">결과</span><span class="detail-value">${escapeHtml(verdict)}</span></div>
  `;
}

// ── Leaderboard ─────────────────────────────────────

function renderLeaderboard(data) {
  const entries = data.leaderboard.filter((entry) => entry.passFail === "pass");
  document.querySelector("[data-leaderboard]").innerHTML = entries.length
    ? entries
        .map((entry, i) => {
          const badge = '<span class="result-badge result-badge--pass">pass</span>';
          return `<tr><td class="rank-no">${i + 1}</td><td class="rank-problem">${escapeHtml(entry.problemId)}</td><td class="col-status">${badge}</td><td class="col-loc">+${escapeHtml(entry.locAdded ?? 0)}</td></tr>`;
        })
        .join("")
    : '<tr><td colspan="4" class="hint">아직 공개 리더보드 제출이 없습니다.</td></tr>';
}

// ── Discussion and review flows ─────────────────────

function renderDiscussion(data) {
  const communityEnabled = canDiscuss(data) || canVote(data);
  const communityPanel = communityEnabled
    ? `<section class="api-panel">
        <h3>커뮤니티 쓰기</h3>
        <form data-community-form class="form-grid">
          <label>문제<select name="problemId" ${canDiscuss(data) ? "" : "disabled"}>${problemOptions(data)}</select></label>
          <label>토론<textarea name="markdown" rows="4" ${canDiscuss(data) ? "" : "disabled"} placeholder="증거와 재현 가능한 설명만 작성하세요."></textarea></label>
          <button type="submit" ${canDiscuss(data) ? "" : "disabled"}>토론 작성</button>
        </form>
        <form data-tag-form class="form-grid form-grid--inline">
          <label>태그 대상<select name="problemId" ${canDiscuss(data) ? "" : "disabled"}>${problemOptions(data)}</select></label>
          <label>태그<input name="tag" ${canDiscuss(data) ? "" : "disabled"} placeholder="dp, parsing, edge-case" /></label>
          <button type="submit" ${canDiscuss(data) ? "" : "disabled"}>태그 제안</button>
        </form>
        <form data-difficulty-form class="form-grid form-grid--inline">
          <label>난이도 문제<select name="problemId" ${canVote(data) ? "" : "disabled"}>${problemOptions(data)}</select></label>
          <label>값<select name="value" ${canVote(data) ? "" : "disabled"}><option>1</option><option>2</option><option selected>3</option><option>4</option><option>5</option></select></label>
          <button type="submit" ${canVote(data) ? "" : "disabled"}>난이도 투표</button>
        </form>
        <div class="action-status" data-community-status>작성 대기 중</div>
      </section>`
    : `<section class="api-panel"><h3>커뮤니티</h3><p class="hint">정적 공개 모드는 읽기 전용입니다. 토론, 태그, 난이도 투표는 구성된 API와 권한이 있을 때만 표시됩니다.</p></section>`;
  document.querySelector("[data-discussion]").innerHTML = `
    <p class="hint"><strong>리뷰어 노트:</strong> 사후 솔루션 녹화, 명령어, 증거, 재사용 가능한 교훈을 선호합니다. Do not post raw chain-of-thought.</p>
    ${communityPanel}
    ${isReviewer(data) ? `<section class="api-panel"><h3>리뷰어 승인</h3><button data-reviewer-refresh>리뷰 큐 새로고침</button><div class="action-status" data-reviewer-queue></div></section>` : ""}
  `;
}

function renderReviewerQueue(container, queue) {
  const recordings = queue.pendingRecordings.map((item) => `<li><code>${escapeHtml(item.recordingId)}</code> ${escapeHtml(item.problemId)} · ${escapeHtml(item.summary)} <button data-approve-recording="${escapeHtml(item.recordingId)}">memory 승인</button></li>`).join("") || "<li>대기 중인 recording 없음</li>";
  const tags = queue.pendingTags.map((item) => `<li><code>${escapeHtml(item.id)}</code> ${escapeHtml(item.targetId)} · ${escapeHtml(item.tag)} <button data-approve-tag="${escapeHtml(item.id)}">태그 승인</button></li>`).join("") || "<li>대기 중인 태그 없음</li>";
  const difficulties = queue.difficultyVotes.map((item) => `<li>${escapeHtml(item.problemId)} · 평균 ${escapeHtml(item.averageValue.toFixed(1))} (${escapeHtml(item.voteCount)}) <button data-approve-difficulty="${escapeHtml(item.problemId)}">난이도 승인</button></li>`).join("") || "<li>대기 중인 난이도 없음</li>";
  container.innerHTML = `<h4>Recording</h4><ul>${recordings}</ul><h4>Tags</h4><ul>${tags}</ul><h4>Difficulty</h4><ul>${difficulties}</ul>`;
}

// ── Memory search ───────────────────────────────────

function renderMemorySearch(data) {
  const rows = data.memory.length
    ? data.memory
        .map((item) => `<li><code>${escapeHtml(item.errorSignature)}</code><br>${escapeHtml(item.actionChecklist.join(" → "))}</li>`)
        .join("")
    : `<li>아직 공개 승인된 troubleshooting memory가 없습니다.</li>`;
  document.querySelector("[data-memory-search]").innerHTML = `
    <p class="hint"><strong>쿼리:</strong> error=<code>target edge case</code>, framework=<code>python</code></p>
    <ul>${rows}</ul>
  `;
}

// ── View switching ──────────────────────────────────

const VIEW_MAP = {
  problems: "problem-list",
  leaderboard: "leaderboard",
  submission: "submission-result",
  memory: "memory-search",
  discussion: "discussion",
};

function switchView(view) {
  const targetId = VIEW_MAP[view];
  if (!targetId) return;

  for (const section of document.querySelectorAll(".view")) {
    section.classList.toggle("view--active", section.id === targetId);
  }

  for (const nav of document.querySelectorAll(".nav-link")) {
    nav.classList.toggle("active", nav.dataset.view === view);
  }

  if (view === "problems") {
    const detail = document.getElementById("problem-detail");
    if (detail) detail.classList.remove("view--active");
  }
}

function wireNav() {
  for (const nav of document.querySelectorAll(".nav-link")) {
    nav.addEventListener("click", () => switchView(nav.dataset.view));
  }

  document.querySelector("[data-problem-list]").addEventListener("click", (event) => {
    const row = event.target.closest("[data-problem-id]");
    if (!row) return;
    const data = window.__agentojData;
    if (!data) return;
    const problem = data.problems.find((item) => item.id === row.dataset.problemId);
    if (problem) {
      renderProblemDetail(data, problem);
      switchView("problems");
      const detail = document.getElementById("problem-detail");
      if (detail) {
        detail.classList.add("view--active");
        detail.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
  });
}

function wireWriteFlows(data) {
  document.querySelector("[data-submit-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const result = await apiRequest(data, "/api/submissions", {
        body: {
          problemId: form.get("problemId"),
          patch: form.get("patch"),
          visibility: form.get("visibility"),
        },
      });
      const submissionId = result.submission.submissionId;
      setStatus("[data-submit-status]", `queued ${submissionId}`, "pending");
      await renderOwnSubmissionStatus(data, submissionId);
    } catch (error) {
      setStatus("[data-submit-status]", error.message, "fail");
    }
  });

  document.querySelector("[data-community-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await apiRequest(data, `/api/problems/${encodeURIComponent(form.get("problemId"))}/discussions`, { body: { markdown: form.get("markdown") } });
      setStatus("[data-community-status]", "토론 작성 완료", "pass");
    } catch (error) {
      setStatus("[data-community-status]", error.message, "fail");
    }
  });

  document.querySelector("[data-tag-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await apiRequest(data, "/api/tags/suggestions", { body: { targetType: "problem", targetId: form.get("problemId"), tag: form.get("tag") } });
      setStatus("[data-community-status]", "태그 제안 완료", "pass");
    } catch (error) {
      setStatus("[data-community-status]", error.message, "fail");
    }
  });

  document.querySelector("[data-difficulty-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await apiRequest(data, `/api/problems/${encodeURIComponent(form.get("problemId"))}/difficulty/votes`, { body: { value: Number(form.get("value")) } });
      setStatus("[data-community-status]", "난이도 투표 완료", "pass");
    } catch (error) {
      setStatus("[data-community-status]", error.message, "fail");
    }
  });

  document.querySelector("[data-reviewer-refresh]")?.addEventListener("click", async () => {
    const container = document.querySelector("[data-reviewer-queue]");
    try {
      const result = await apiRequest(data, "/api/reviewer/queue", { method: "GET" });
      renderReviewerQueue(container, result.queue);
    } catch (error) {
      container.textContent = error.message;
    }
  });

  document.querySelector("[data-reviewer-queue]")?.addEventListener("click", async (event) => {
    const recordingId = event.target.dataset.approveRecording;
    const tagId = event.target.dataset.approveTag;
    const problemId = event.target.dataset.approveDifficulty;
    if (!recordingId && !tagId && !problemId) return;
    try {
      if (recordingId) await apiRequest(data, `/api/admin/recordings/${encodeURIComponent(recordingId)}/approve`);
      if (tagId) await apiRequest(data, `/api/admin/tags/${encodeURIComponent(tagId)}/approve`);
      if (problemId) await apiRequest(data, `/api/admin/problems/${encodeURIComponent(problemId)}/difficulty/approve`);
      setStatus("[data-community-status]", "승인 완료", "pass");
    } catch (error) {
      setStatus("[data-community-status]", error.message, "fail");
    }
  });

  document.querySelector("[data-worker-refresh]")?.addEventListener("click", async () => {
    try {
      const result = await apiRequest(data, "/api/admin/worker/status", { method: "GET" });
      document.querySelector("[data-admin-worker-status]").textContent = `queued ${result.worker.counts.queued}, running ${result.worker.counts.running}, passed ${result.worker.counts.passed}`;
    } catch (error) {
      setStatus("[data-admin-worker-status]", error.message, "fail");
    }
  });

  document.querySelector("[data-run-worker]")?.addEventListener("click", async () => {
    try {
      const result = await apiRequest(data, "/api/worker/run-next", { body: { sandboxMode: "docker" } });
      document.querySelector("[data-admin-worker-status]").textContent = `worker result: ${result.result ? result.result.status ?? result.result.message ?? "ok" : "no queued jobs"}`;
    } catch (error) {
      setStatus("[data-admin-worker-status]", error.message, "fail");
    }
  });
}

// ── Boot ────────────────────────────────────────────

function render(data) {
  window.__agentojData = data;
  renderStats(data);
  renderProblems(data);
  renderProblemDetail(data);
  renderSubmissionResult(data);
  renderLeaderboard(data);
  renderDiscussion(data);
  renderMemorySearch(data);
  wireNav();
  wireWriteFlows(data);
}

function renderLoadError(error) {
  const safeMessage = escapeHtml(error?.message || "Public data load failed");
  window.__agentojData = { ...fallbackData, source: "static-error", loadError: safeMessage };
  for (const selector of ["[data-problem-list]", "[data-leaderboard]"]) {
    const el = document.querySelector(selector);
    if (el) el.innerHTML = `<tr><td colspan="5" class="hint">공개 데이터를 불러오지 못했습니다: ${safeMessage}</td></tr>`;
  }
  for (const selector of ["[data-problem-detail]", "[data-submission-result]", "[data-discussion]", "[data-memory-search]"]) {
    const el = document.querySelector(selector);
    if (el) el.innerHTML = `<p class="hint">공개 데이터를 불러오지 못했습니다: ${safeMessage}</p>`;
  }
}

loadData().then(render).catch(renderLoadError);
