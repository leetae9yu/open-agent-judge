import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { listAdapterRegistry, listImplementedProblemCatalogs } from "../adapters/registry.ts";
import { isLeaderboardEligible, parsePublicMetricsJson, publicMetricsMatchPatchStats } from "../contracts/validators.ts";
import type { Adapter, Benchmark, LeaderboardEntry, PatchSubmission, Problem, RunnerJob, RunnerResult } from "../contracts/types.ts";
import { dockerAvailable, runPatchVerification, type SandboxMode } from "../runner/local-runner.ts";
import { openAgentOjDatabase } from "../storage/sqlite-store.ts";
import { assertPublicPayloadSafe, isPublicSlug, redactPublicText } from "../public-redaction.ts";
import { badRequest, notFound } from "./errors.ts";

export interface ApiProblemListItem {
  id: string;
  title: string;
  benchmarkId: string;
  adapterId: string;
  upstreamTaskId: string;
  hostingMode: string;
  tags: string[];
  scoringMode?: string;
  oracleDescriptorHash?: string;
}

export interface ApiRegistryItem {
  benchmarkId: string;
  name: string;
  licenseId: string;
  legalStatus: string;
  redistributionRights: string;
  defaultHostingMode: string;
  status: string;
  dataPolicy: string;
}

export interface ApiLeaderboardEntry {
  id: string;
  problemId: string;
  submissionId: string;
  passFail: string;
  runtimeMs: number;
  filesChanged: number;
  locAdded: number;
  locDeleted: number;
  eligibilityStatus: string;
  ineligibilityReason?: string;
}

export interface ApiRecordingSummary {
  id: string;
  problemId: string;
  summary: string;
  rootCause: string;
  fixDescription: string;
  publicSlug: string;
}

export interface ApiMemorySearchResult {
  publicRecordingLink: string;
  errorSignature: string;
  languageFramework: string;
  actionChecklist: string[];
  sourceRecordingIds: string[];
  applicabilityExplanation: string;
}

export interface ApiDiscussionPost {
  id: string;
  problemId: string;
  authorId: string;
  markdown: string;
  moderationState: "visible" | "hidden" | "flagged";
}

export interface ApiTagSuggestion {
  id: string;
  targetId: string;
  targetType: "problem" | "recording";
  tag: string;
  reviewerDecision: "pending" | "approved" | "rejected";
}

export interface ApiCommunitySummary {
  problemId: string;
  discussions: ApiDiscussionPost[];
  approvedTags: string[];
  difficulty: { approvedValue: number; reviewerId: string } | null;
  voteCount: number;
}
export interface ApiSubmissionReceipt {
  submissionId: string;
  jobId: string;
  status: "queued";
}

export interface ApiQueuedJob {
  id: string;
  submissionId: string;
  problemId: string;
  adapterId: string;
  status: string;
}

export interface ApiWorkerRunResult {
  jobId: string;
  submissionId: string;
  status: "passed" | "failed" | "infra-error";
  resultId: string;
  recordingPromoted: false;
  failedAttemptId?: string;
}
export interface ApiSubmissionStatus {
  submissionId: string;
  jobId: string;
  problemId: string;
  userId: string;
  status: string;
  result: { passFail: "pass" | "fail"; runtimeMs: number; memoryPeakMb: number | null } | null;
  failedAttempt: { present: boolean } | null;
  recordingPromoted: false;
}

export interface ApiReviewerQueue {
  pendingRecordings: Array<{ recordingId: string; problemId: string; summary: string; reviewStatus: "pending" }>;
  pendingTags: ApiTagSuggestion[];
  difficultyVotes: Array<{ problemId: string; voteCount: number; averageValue: number }>;
}

export interface ApiWorkerStatus {
  counts: { queued: number; running: number; passed: number; failed: number; infraError: number };
  jobs: Array<{ jobId: string; submissionId: string; problemId: string; status: string; createdAt: string }>;
}

const MAX_PATCH_BYTES = 200_000;
const MAX_PATCH_FILES = 20;
function stableId(prefix: string, seed: string): string {
  return `${prefix}-${seed.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function patchStats(patch: string): PatchSubmission["patchStats"] {
  const lines = patch.split(/\r?\n/);
  const fileTargets = new Set<string>();
  let locAdded = 0;
  let locDeleted = 0;

  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim().split(/\s+/)[0]?.replace(/^b\//, "");
      if (target && target !== "/dev/null") fileTargets.add(target);
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      locAdded += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      locDeleted += 1;
    }
  }

  return {
    filesChanged: fileTargets.size,
    locAdded,
    locDeleted,
  };
}
function checkedRecordingText(field: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw badRequest(`Missing required recording field: ${field}.`);
  if (/(?:raw\s*)?(?:chain[-\s]?of[-\s]?thought|\bcot\b)|hidden reasoning/i.test(trimmed)) {
    throw badRequest(`Recording field ${field} must be a post-hoc evidence summary, not raw reasoning.`);
  }
  return redactPublicText(trimmed);
}

function parsePublicStringArray(jsonText: string): string[] | null {
  try {
    const parsed = JSON.parse(jsonText);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? parsed : null;
  } catch {
    return null;
  }
}

function safePublicDto<T>(dto: T, context: string): T | null {
  try {
    assertPublicPayloadSafe(dto, context);
    return dto;
  } catch {
    return null;
  }
}

function asProblem(row: {
  id: string;
  benchmark_id: string;
  adapter_id: string;
  upstream_task_id: string;
  title: string;
  language_framework_tags_json: string;
  hosting_mode: "hosted" | "adapter-only";
  enabled: number;
}): Problem {
  return {
    id: row.id,
    benchmarkId: row.benchmark_id,
    adapterId: row.adapter_id,
    upstreamTaskId: row.upstream_task_id,
    title: row.title,
    languageFrameworkTags: JSON.parse(row.language_framework_tags_json) as string[],
    hostingMode: row.hosting_mode,
    enabled: row.enabled === 1,
    editableFilePaths: ["solution.py"],
  };
}

function withCatalogRuntimeMetadata(problem: Problem): Problem {
  const catalogProblem = listImplementedProblemCatalogs().find((entry) => entry.problem.id === problem.id)?.problem;
  if (!catalogProblem) return problem;
  return {
    ...problem,
    scoringMode: catalogProblem.scoringMode,
    oracleMetadata: catalogProblem.oracleMetadata,
  };
}
function asBenchmark(row: {
  benchmark_id: string;
  benchmark_name: string;
  upstream_url: string;
  upstream_commit_or_version: string;
  license_id: Benchmark["licenseId"];
  legal_status: Benchmark["legalStatus"];
  redistribution_rights: Benchmark["redistributionRights"];
  default_hosting_mode: Benchmark["defaultHostingMode"];
}): Benchmark {
  return {
    id: row.benchmark_id,
    name: row.benchmark_name,
    upstreamUrl: row.upstream_url,
    upstreamCommitOrVersion: row.upstream_commit_or_version,
    licenseId: row.license_id,
    legalStatus: row.legal_status,
    redistributionRights: row.redistribution_rights,
    defaultHostingMode: row.default_hosting_mode,
  };
}

function asAdapter(row: {
  adapter_id: string;
  benchmark_id: string;
  adapter_version: string;
  fetch_strategy: Adapter["fetchStrategy"];
  judge_command_json: string;
  verification_commands_json: string;
  supported_hosting_modes_json: string;
  docker_image_digest: string;
  resources_json: string;
}): Adapter {
  return {
    id: row.adapter_id,
    benchmarkId: row.benchmark_id,
    adapterVersion: row.adapter_version,
    fetchStrategy: row.fetch_strategy,
    judgeCommand: JSON.parse(row.judge_command_json) as string[],
    verificationCommands: JSON.parse(row.verification_commands_json) as string[][],
    supportedHostingModes: JSON.parse(row.supported_hosting_modes_json) as Adapter["supportedHostingModes"],
    dockerImageDigest: row.docker_image_digest,
    defaultResources: JSON.parse(row.resources_json) as Adapter["defaultResources"],
  };
}

function syntheticResult(jobId: string, message: string): RunnerResult {
  const digest = sha256(`${jobId}:${message}`);
  return {
    id: stableId("result", jobId),
    jobId,
    patchApplyStatus: "failed",
    exitCode: 1,
    passFail: "fail",
    runtimeMs: 1,
    memoryPeakMb: null,
    stdoutRef: `stdout:${sha256("")}`,
    stderrRef: `stderr:${digest}`,
    resultHash: `result:${digest}`,
  };
}


export class AgentOjRepository {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  static open(path: string): AgentOjRepository {
    const repository = new AgentOjRepository(openAgentOjDatabase(path));
    repository.seedBundledCatalog();
    return repository;
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  seedBundledCatalog(): void {
    const insertBenchmark = this.db.prepare(
      `INSERT OR IGNORE INTO benchmarks
        (id, name, upstream_url, upstream_commit_or_version, license_id, legal_status, redistribution_rights, default_hosting_mode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertAdapter = this.db.prepare(
      `INSERT OR IGNORE INTO adapters
        (id, benchmark_id, adapter_version, fetch_strategy, judge_command_json, verification_commands_json, supported_hosting_modes_json, docker_image_digest, resources_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertedAdapters = new Set<string>();
    for (const entry of listAdapterRegistry()) {
      if (entry.status !== "implemented" || !entry.adapter) continue;
      insertBenchmark.run(
        entry.benchmark.id,
        entry.benchmark.name,
        entry.benchmark.upstreamUrl,
        entry.benchmark.upstreamCommitOrVersion,
        entry.benchmark.licenseId,
        entry.benchmark.legalStatus,
        entry.benchmark.redistributionRights,
        entry.benchmark.defaultHostingMode,
      );
      if (insertedAdapters.has(entry.adapter.id)) continue;
      insertedAdapters.add(entry.adapter.id);
      insertAdapter.run(
        entry.adapter.id,
        entry.adapter.benchmarkId,
        entry.adapter.adapterVersion,
        entry.adapter.fetchStrategy,
        JSON.stringify(entry.adapter.judgeCommand),
        JSON.stringify(entry.adapter.verificationCommands),
        JSON.stringify(entry.adapter.supportedHostingModes),
        entry.adapter.dockerImageDigest,
        JSON.stringify(entry.adapter.defaultResources),
      );
    }

    const insertProblem = this.db.prepare(
      `INSERT OR IGNORE INTO problems
        (id, benchmark_id, adapter_id, upstream_task_id, title, language_framework_tags_json, hosting_mode, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const { problem } of listImplementedProblemCatalogs()) {
      insertProblem.run(
        problem.id,
        problem.benchmarkId,
        problem.adapterId,
        problem.upstreamTaskId,
        problem.title,
        JSON.stringify(problem.languageFrameworkTags),
        problem.hostingMode,
        problem.enabled ? 1 : 0,
      );
    }
  }

  private loadProblemRuntime(id: string): { problem: Problem; benchmark: Benchmark; adapter: Adapter } {
    const row = this.db
      .prepare(
        `SELECT p.id, p.benchmark_id, p.adapter_id, p.upstream_task_id, p.title, p.language_framework_tags_json, p.hosting_mode, p.enabled,
                b.name AS benchmark_name, b.upstream_url, b.upstream_commit_or_version, b.license_id, b.legal_status, b.redistribution_rights, b.default_hosting_mode,
                a.adapter_version, a.fetch_strategy, a.judge_command_json, a.verification_commands_json, a.supported_hosting_modes_json, a.docker_image_digest, a.resources_json
         FROM problems p
         JOIN benchmarks b ON b.id = p.benchmark_id
         JOIN adapters a ON a.id = p.adapter_id
         WHERE p.id = ?
           AND p.enabled = 1
           AND b.legal_status = 'approved'
           AND (p.hosting_mode = 'adapter-only' OR b.redistribution_rights = 'clear')`,
      )
      .get(id) as
      | {
          id: string;
          benchmark_id: string;
          adapter_id: string;
          upstream_task_id: string;
          title: string;
          language_framework_tags_json: string;
          hosting_mode: "hosted" | "adapter-only";
          enabled: number;
          benchmark_name: string;
          upstream_url: string;
          upstream_commit_or_version: string;
          license_id: Benchmark["licenseId"];
          legal_status: Benchmark["legalStatus"];
          redistribution_rights: Benchmark["redistributionRights"];
          default_hosting_mode: Benchmark["defaultHostingMode"];
          adapter_version: string;
          fetch_strategy: Adapter["fetchStrategy"];
          judge_command_json: string;
          verification_commands_json: string;
          supported_hosting_modes_json: string;
          docker_image_digest: string;
          resources_json: string;
        }
      | undefined;
    if (!row) throw notFound(`Unknown problem id: ${id}`);
    return { problem: withCatalogRuntimeMetadata(asProblem(row)), benchmark: asBenchmark(row), adapter: asAdapter(row) };
  }
  private loadProblemEntity(id: string): Problem {
    const row = this.db
      .prepare(
        `SELECT p.id, p.benchmark_id, p.adapter_id, p.upstream_task_id, p.title, p.language_framework_tags_json, p.hosting_mode, p.enabled
         FROM problems p
         JOIN benchmarks b ON b.id = p.benchmark_id
         WHERE p.id = ?
           AND p.enabled = 1
           AND b.legal_status = 'approved'
           AND (p.hosting_mode = 'adapter-only' OR b.redistribution_rights = 'clear')`,
      )
      .get(id) as
      | {
          id: string;
          benchmark_id: string;
          adapter_id: string;
          upstream_task_id: string;
          title: string;
          language_framework_tags_json: string;
          hosting_mode: "hosted" | "adapter-only";
          enabled: number;
        }
      | undefined;
    if (!row) throw notFound(`Unknown problem id: ${id}`);
    return withCatalogRuntimeMetadata(asProblem(row));
  }

  submitPatch(input: { problemId: string; patch: string; userId: string; visibility?: PatchSubmission["visibility"] }): ApiSubmissionReceipt {
    if (!input.patch.trim()) throw badRequest("Submission patch is required.");
    if (Buffer.byteLength(input.patch, "utf8") > MAX_PATCH_BYTES) throw badRequest(`Submission patch must be ${MAX_PATCH_BYTES} bytes or smaller.`);
    const { problem, benchmark, adapter } = this.loadProblemRuntime(input.problemId);
    const stats = patchStats(input.patch);
    if (stats.filesChanged === 0) throw badRequest("Submission patch must be a unified diff.");
    if (stats.filesChanged > MAX_PATCH_FILES) throw badRequest(`Submission patch may touch at most ${MAX_PATCH_FILES} files.`);

    const patchHash = sha256(input.patch);
    const submissionSeed = `${input.userId}-${problem.id}-${patchHash}-${Date.now()}`;
    const submissionId = stableId("submission", submissionSeed);
    const jobId = stableId("job", `${submissionId}-queued`);
    const submission: PatchSubmission = {
      id: submissionId,
      userId: input.userId,
      problemId: problem.id,
      patchSha256: `sha256:${patchHash}`,
      patchStats: stats,
      visibility: input.visibility ?? "private",
      publicMetrics: {
        passFail: "fail",
        runtimeMs: 1,
        filesChanged: stats.filesChanged,
        locAdded: stats.locAdded,
        locDeleted: stats.locDeleted,
      },
    };

    return this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO submissions
            (id, user_id, problem_id, patch_sha256, patch_stats_json, supplied_metrics_json, visibility, public_metrics_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          submission.id,
          submission.userId,
          submission.problemId,
          submission.patchSha256,
          JSON.stringify(submission.patchStats),
          null,
          submission.visibility,
          JSON.stringify(submission.publicMetrics),
        );
      this.db.prepare("INSERT INTO submission_patches (submission_id, patch_text) VALUES (?, ?)").run(submission.id, input.patch);
      this.db
        .prepare(
          `INSERT INTO runner_jobs
            (id, submission_id, adapter_id, upstream_commit, docker_image_digest, resources_json, status, scoring_status, sandbox_mode, oracle_descriptor_hash)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', 'demo', 'local', NULL)`,
        )
        .run(
          jobId,
          submission.id,
          problem.adapterId,
          benchmark.upstreamCommitOrVersion,
          adapter.dockerImageDigest,
          JSON.stringify(adapter.defaultResources),
        );
      return { submissionId: submission.id, jobId, status: "queued" };
    });
  }

  claimNextQueuedJob(): ApiQueuedJob | null {
    return this.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT j.id, j.submission_id, s.problem_id, j.adapter_id, j.status
           FROM runner_jobs j
           JOIN submissions s ON s.id = j.submission_id
           WHERE j.status = 'queued'
           ORDER BY j.created_at, j.id
           LIMIT 1`,
        )
        .get() as { id: string; submission_id: string; problem_id: string; adapter_id: string; status: string } | undefined;
      if (!row) return null;
      const updated = this.db.prepare("UPDATE runner_jobs SET status = 'running' WHERE id = ? AND status = 'queued'").run(row.id);
      if (updated.changes !== 1) return null;
      return {
        id: row.id,
        submissionId: row.submission_id,
        problemId: row.problem_id,
        adapterId: row.adapter_id,
        status: "running",
      };
    });
  }

  runNextQueuedJob(sandboxMode: SandboxMode = "local"): ApiWorkerRunResult | null {
    const claimed = this.claimNextQueuedJob();
    if (!claimed) return null;

    const row = this.db
      .prepare(
        `SELECT s.id AS submission_id, s.user_id, s.problem_id, s.patch_sha256, s.patch_stats_json, s.visibility, s.public_metrics_json,
                sp.patch_text
         FROM submissions s
         JOIN submission_patches sp ON sp.submission_id = s.id
         WHERE s.id = ?`,
      )
      .get(claimed.submissionId) as
      | {
          submission_id: string;
          user_id: string;
          problem_id: string;
          patch_sha256: string;
          patch_stats_json: string;
          visibility: PatchSubmission["visibility"];
          public_metrics_json: string;
          patch_text: string;
        }
      | undefined;

    const terminalize = (status: ApiWorkerRunResult["status"], result: RunnerResult, error: string, job?: RunnerJob): ApiWorkerRunResult => {
      this.transaction(() => {
        this.db.prepare("UPDATE runner_jobs SET status = ?, scoring_status = ?, sandbox_mode = ?, oracle_descriptor_hash = ? WHERE id = ? AND status = 'running'").run(status, job?.scoringStatus ?? "demo", job?.sandboxMode ?? sandboxMode, job?.oracleDescriptorHash ?? null, claimed.id);
        this.db
          .prepare(
            `INSERT OR REPLACE INTO runner_results
              (id, job_id, patch_apply_status, exit_code, pass_fail, runtime_ms, memory_peak_mb, stdout_ref, stderr_ref, result_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            result.id,
            result.jobId,
            result.patchApplyStatus,
            result.exitCode,
            result.passFail,
            result.runtimeMs,
            result.memoryPeakMb,
            result.stdoutRef,
            result.stderrRef,
            result.resultHash,
          );
        if (status !== "passed") {
          this.db
            .prepare(
              `INSERT OR REPLACE INTO failed_run_attempts
                (id, submission_id, problem_id, runner_job_id, runner_result_id, error)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(`failed-${claimed.submissionId}`, claimed.submissionId, claimed.problemId, claimed.id, result.id, error);
        }
      });
      return {
        jobId: claimed.id,
        submissionId: claimed.submissionId,
        status,
        resultId: result.id,
        recordingPromoted: false,
        failedAttemptId: status !== "passed" ? `failed-${claimed.submissionId}` : undefined,
      };
    };

    if (!row) {
      return terminalize("infra-error", syntheticResult(claimed.id, "claimed submission missing"), "claimed submission missing");
    }

    try {
      const { problem, benchmark, adapter } = this.loadProblemRuntime(row.problem_id);
      if (claimed.adapterId !== adapter.id) {
        return terminalize(
          "infra-error",
          syntheticResult(claimed.id, `claimed adapter mismatch: ${claimed.adapterId} != ${adapter.id}`),
          `claimed adapter mismatch: ${claimed.adapterId} != ${adapter.id}`,
        );
      }

      if (sandboxMode === "docker" && !dockerAvailable()) {
        return terminalize(
          "infra-error",
          syntheticResult(claimed.id, "docker unavailable and fallback is disabled for API workers"),
          "docker unavailable and fallback is disabled for API workers",
        );
      }
      const submission: PatchSubmission = {
        id: row.submission_id,
        userId: row.user_id,
        problemId: row.problem_id,
        patchSha256: row.patch_sha256,
        patchStats: JSON.parse(row.patch_stats_json) as PatchSubmission["patchStats"],
        visibility: row.visibility,
        publicMetrics: JSON.parse(row.public_metrics_json) as PatchSubmission["publicMetrics"],
      };

      const verification = runPatchVerification(
        {
          benchmark,
          adapter,
          problem,
          submission,
          patch: row.patch_text,
        },
        sandboxMode,
      );

      const hiddenScored = problem.scoringMode !== "scored-hidden" || (verification.job.scoringStatus === "scored" && verification.job.oracleDescriptorHash === problem.oracleMetadata?.oracleDescriptorHash);
      const status: ApiWorkerRunResult["status"] = verification.result.passFail === "pass" && hiddenScored ? "passed" : "failed";
      const result: RunnerResult = {
        ...verification.result,
        id: stableId("result", claimed.id),
        jobId: claimed.id,
      };
      return terminalize(status, result, hiddenScored ? verification.stderr || "runner failed" : "scored-hidden submissions require matching private oracle execution", verification.job);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return terminalize("infra-error", syntheticResult(claimed.id, message), message);
    }
  }
  getSubmissionStatus(submissionId: string, viewerUserId?: string): ApiSubmissionStatus {
    const row = this.db
      .prepare(
        `SELECT s.id AS submission_id, s.user_id, s.problem_id, j.id AS job_id, j.status,
                rr.pass_fail, rr.runtime_ms, rr.memory_peak_mb,
                far.id AS failed_attempt_id,
                pm.id AS public_memory_id
         FROM submissions s
         JOIN runner_jobs j ON j.submission_id = s.id
         LEFT JOIN runner_results rr ON rr.job_id = j.id
         LEFT JOIN failed_run_attempts far ON far.submission_id = s.id
         LEFT JOIN solution_recordings sr ON sr.submission_id = s.id
         LEFT JOIN public_memory_entries pm ON pm.recording_id = sr.id
         WHERE s.id = ?
           AND (? IS NULL OR s.user_id = ?)`,
      )
      .get(submissionId, viewerUserId ?? null, viewerUserId ?? null) as
      | {
          submission_id: string;
          user_id: string;
          problem_id: string;
          job_id: string;
          status: string;
          pass_fail: "pass" | "fail" | null;
          runtime_ms: number | null;
          memory_peak_mb: number | null;
          failed_attempt_id: string | null;
          public_memory_id: string | null;
        }
      | undefined;
    if (!row) throw notFound(`Unknown submission id: ${submissionId}`);
    return {
      submissionId: row.submission_id,
      jobId: row.job_id,
      problemId: row.problem_id,
      userId: row.user_id,
      status: row.status,
      result:
        row.pass_fail && row.runtime_ms !== null
          ? { passFail: row.pass_fail, runtimeMs: row.runtime_ms, memoryPeakMb: row.memory_peak_mb }
          : null,
      failedAttempt: row.failed_attempt_id ? { present: true } : null,
      recordingPromoted: false,
    };
  }

  getWorkerStatus(): ApiWorkerStatus {
    const rows = this.db
      .prepare(
        `SELECT j.id, j.submission_id, s.problem_id, j.status, j.created_at
         FROM runner_jobs j
         JOIN submissions s ON s.id = j.submission_id
         ORDER BY j.created_at DESC, j.id DESC
         LIMIT 25`,
      )
      .all() as Array<{ id: string; submission_id: string; problem_id: string; status: string; created_at: string }>;
    const countsRows = this.db.prepare("SELECT status, COUNT(*) AS count FROM runner_jobs GROUP BY status").all() as Array<{ status: string; count: number }>;
    const count = (status: string): number => countsRows.find((row) => row.status === status)?.count ?? 0;
    return {
      counts: {
        queued: count("queued"),
        running: count("running"),
        passed: count("passed"),
        failed: count("failed"),
        infraError: count("infra-error"),
      },
      jobs: rows.map((row) => ({
        jobId: row.id,
        submissionId: row.submission_id,
        problemId: row.problem_id,
        status: row.status,
        createdAt: row.created_at,
      })),
    };
  }

  getReviewerQueue(): ApiReviewerQueue {
    const pendingRecordings = this.db
      .prepare(
        `SELECT r.id, r.problem_id, r.summary
         FROM solution_recordings r
         JOIN review_gates rg ON rg.recording_id = r.id
         WHERE rg.automatic_check_status = 'pass'
           AND rg.trusted_reviewer_approval_status = 'pending'
         ORDER BY r.id`,
      )
      .all() as Array<{ id: string; problem_id: string; summary: string }>;
    const pendingTags = this.db
      .prepare(
        `SELECT id, target_id, target_type, tag
         FROM tag_suggestions
         WHERE reviewer_decision = 'pending'
         ORDER BY id`,
      )
      .all() as Array<{ id: string; target_id: string; target_type: "problem" | "recording"; tag: string }>;
    const difficultyVotes = this.db
      .prepare(
        `SELECT problem_id, COUNT(*) AS vote_count, AVG(value) AS average_value
         FROM difficulty_votes
         GROUP BY problem_id
         HAVING vote_count > 0
         ORDER BY problem_id`,
      )
      .all() as Array<{ problem_id: string; vote_count: number; average_value: number }>;

    return {
      pendingRecordings: pendingRecordings.map((row) => ({
        recordingId: row.id,
        problemId: row.problem_id,
        summary: row.summary,
        reviewStatus: "pending",
      })),
      pendingTags: pendingTags.map((row) => ({
        id: row.id,
        targetId: row.target_id,
        targetType: row.target_type,
        tag: row.tag,
        reviewerDecision: "pending",
      })),
      difficultyVotes: difficultyVotes.map((row) => ({
        problemId: row.problem_id,
        voteCount: row.vote_count,
        averageValue: row.average_value,
      })),
    };
  }
  createPendingRecordingFromJob(input: {
    jobId: string;
    summary: string;
    rootCause: string;
    fixDescription: string;
  }): { recordingId: string; reviewStatus: "pending" | "approved" | "rejected" } {
    const summary = checkedRecordingText("summary", input.summary);
    const rootCause = checkedRecordingText("rootCause", input.rootCause);
    const fixDescription = checkedRecordingText("fixDescription", input.fixDescription);
    const row = this.db
      .prepare(
        `SELECT j.id AS job_id, j.upstream_commit, j.docker_image_digest, j.resources_json,
                rr.patch_apply_status, rr.exit_code, rr.pass_fail, rr.result_hash,
                s.id AS submission_id, s.problem_id, s.patch_sha256, s.patch_stats_json, s.supplied_metrics_json,
                p.benchmark_id, a.verification_commands_json
         FROM runner_jobs j
         JOIN runner_results rr ON rr.job_id = j.id
         JOIN submissions s ON s.id = j.submission_id
         JOIN problems p ON p.id = s.problem_id
         JOIN adapters a ON a.id = j.adapter_id
         WHERE j.id = ? AND j.status = 'passed'`,
      )
      .get(input.jobId) as
      | {
          job_id: string;
          upstream_commit: string;
          docker_image_digest: string;
          resources_json: string;
          patch_apply_status: string;
          exit_code: number;
          pass_fail: string;
          result_hash: string;
          submission_id: string;
          problem_id: string;
          patch_sha256: string;
          patch_stats_json: string;
          supplied_metrics_json: string | null;
          benchmark_id: string;
          verification_commands_json: string;
        }
      | undefined;
    if (!row) throw notFound(`Unknown completed job id: ${input.jobId}`);
    if (row.patch_apply_status !== "clean" || row.exit_code !== 0 || row.pass_fail !== "pass") {
      throw badRequest("Recording creation requires a clean passing job result.");
    }

    const patch = JSON.parse(row.patch_stats_json) as PatchSubmission["patchStats"];
    const recordingId = stableId("recording", row.submission_id);
    const evidenceId = stableId("evidence", row.submission_id);
    const reviewId = stableId("review", recordingId);
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO solution_recordings
            (id, submission_id, problem_id, benchmark_id, upstream_commit, docker_image_digest, resources_json,
             final_patch_sha256, pass_fail, loc_delta_json, token_metrics_json, summary, root_cause, fix_description,
             verification_commands_json, evidence_ledger_id, schema_version, immutable, scoring_status, original_job_id,
             original_result_id, original_result_hash, oracle_descriptor_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pass', ?, ?, ?, ?, ?, ?, ?, 1, 1, 'demo', ?, ?, ?, NULL)`,
        )
        .run(
          recordingId,
          row.submission_id,
          row.problem_id,
          row.benchmark_id,
          row.upstream_commit,
          row.docker_image_digest,
          row.resources_json,
          row.patch_sha256,
          JSON.stringify({ added: patch.locAdded, deleted: patch.locDeleted }),
          row.supplied_metrics_json,
          summary,
          rootCause,
          fixDescription,
          row.verification_commands_json,
          evidenceId,
          row.job_id,
          stableId("result", row.job_id),
          row.result_hash,
        );
      this.db
        .prepare(
          `INSERT OR IGNORE INTO evidence_ledgers
            (id, recording_id, required_field_check, patch_clean_apply_check, verification_exit_zero_check,
             sandbox_rerun_check, rerun_job_id, original_job_id, original_result_id, original_result_hash,
             rerun_result_id, rerun_result_hash, oracle_descriptor_hash, checker_version, evidence_hash)
           VALUES (?, ?, 'pass', 'pass', 'pass', 'fail', ?, ?, ?, ?, ?, ?, '', 'api-worker-1', ?)`,
        )
        .run(evidenceId, recordingId, row.job_id, row.job_id, stableId("result", row.job_id), row.result_hash, stableId("result", row.job_id), row.result_hash, `evidence:${recordingId}:${row.result_hash}`);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO review_gates
            (id, recording_id, automatic_check_status, trusted_reviewer_approval_status, reviewer_id, reviewer_notes)
           VALUES (?, ?, 'pass', 'pending', NULL, NULL)`,
        )
        .run(reviewId, recordingId);
    });

    const review = this.db
      .prepare("SELECT trusted_reviewer_approval_status FROM review_gates WHERE recording_id = ?")
      .get(recordingId) as { trusted_reviewer_approval_status: "pending" | "approved" | "rejected" } | undefined;
    return { recordingId, reviewStatus: review?.trusted_reviewer_approval_status ?? "pending" };
  }

  approveRecordingForPublicMemory(recordingId: string, reviewerId: string): { recordingId: string; publicSlug: string } {
    const row = this.db
      .prepare(
        `SELECT r.id, r.problem_id, r.root_cause, r.fix_description, r.verification_commands_json,
                p.language_framework_tags_json,
                e.required_field_check, e.patch_clean_apply_check, e.verification_exit_zero_check, e.sandbox_rerun_check
         FROM solution_recordings r
         JOIN problems p ON p.id = r.problem_id
         JOIN evidence_ledgers e ON e.recording_id = r.id
         JOIN review_gates rg ON rg.recording_id = r.id
         JOIN runner_jobs oj ON oj.id = r.original_job_id
         JOIN runner_results orr ON orr.id = r.original_result_id AND orr.job_id = oj.id
         JOIN runner_jobs rj ON rj.id = e.rerun_job_id
         JOIN runner_results rrr ON rrr.id = e.rerun_result_id AND rrr.job_id = rj.id
         WHERE r.id = ? AND rg.automatic_check_status = 'pass' AND rg.trusted_reviewer_approval_status = 'pending'
           AND r.scoring_status = 'scored'
           AND r.oracle_descriptor_hash IS NOT NULL
           AND r.oracle_descriptor_hash = e.oracle_descriptor_hash
           AND e.original_job_id = r.original_job_id
           AND e.original_result_id = r.original_result_id
           AND e.original_result_hash = r.original_result_hash
           AND e.rerun_job_id <> r.original_job_id
           AND e.rerun_result_id <> r.original_result_id
           AND e.rerun_result_hash <> r.original_result_hash
           AND oj.scoring_status = 'scored'
           AND oj.sandbox_mode = 'docker'
           AND oj.oracle_descriptor_hash = r.oracle_descriptor_hash
           AND rj.scoring_status = 'scored'
           AND rj.sandbox_mode = 'docker'
           AND rj.oracle_descriptor_hash = r.oracle_descriptor_hash
           AND orr.result_hash = r.original_result_hash
           AND rrr.result_hash = e.rerun_result_hash`,
      )
      .get(recordingId) as
      | {
          id: string;
          problem_id: string;
          root_cause: string;
          fix_description: string;
          verification_commands_json: string;
          language_framework_tags_json: string;
          required_field_check: string;
          patch_clean_apply_check: string;
          verification_exit_zero_check: string;
          sandbox_rerun_check: string;
        }
      | undefined;
    if (!row) throw notFound(`Unknown approvable recording id: ${recordingId}`);
    for (const check of [row.required_field_check, row.patch_clean_apply_check, row.verification_exit_zero_check, row.sandbox_rerun_check]) {
      if (check !== "pass") throw badRequest("Recording evidence is not eligible for public memory.");
    }

    const checklistId = stableId("checklist", recordingId);
    const publicMemoryId = stableId("public-memory", recordingId);
    const publicSlug = `/recordings/${recordingId}`;
    const tags = JSON.parse(row.language_framework_tags_json) as string[];
    const commands = JSON.parse(row.verification_commands_json) as string[][];
    this.transaction(() => {
      this.db
        .prepare(
          "UPDATE review_gates SET trusted_reviewer_approval_status = 'approved', reviewer_id = ?, reviewer_notes = ? WHERE recording_id = ?",
        )
        .run(reviewerId, "Trusted reviewer approved this post-hoc recording for public troubleshooting memory.", recordingId);
      this.db
        .prepare(
          `INSERT OR REPLACE INTO public_memory_entries
            (id, recording_id, public_slug, source_checklist_case_ids_json)
           VALUES (?, ?, ?, ?)`,
        )
        .run(publicMemoryId, recordingId, publicSlug, JSON.stringify([checklistId]));
      this.db
        .prepare(
          `INSERT OR REPLACE INTO checklist_cases
            (id, public_memory_entry_id, recording_id, language_framework, error_signature, action_checklist_json, source_recording_ids_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          checklistId,
          publicMemoryId,
          recordingId,
          tags[0] ?? "unknown",
          row.root_cause,
          JSON.stringify([row.fix_description, ...commands.map((command) => command.join(" "))]),
          JSON.stringify([recordingId]),
        );
    });

    return { recordingId, publicSlug };
  }
  getProblemCommunity(problemId: string): ApiCommunitySummary {
    this.getProblem(problemId);
    const discussions = this.db
      .prepare(
        `SELECT id, problem_id, author_id, markdown, moderation_state
         FROM discussion_posts
         WHERE problem_id = ? AND moderation_state = 'visible'
         ORDER BY created_at, id`,
      )
      .all(problemId) as Array<{ id: string; problem_id: string; author_id: string; markdown: string; moderation_state: "visible" }>;
    const tags = this.db
      .prepare(
        `SELECT tag
         FROM tag_suggestions
         WHERE target_id = ? AND target_type = 'problem' AND reviewer_decision = 'approved'
         ORDER BY tag`,
      )
      .all(problemId) as Array<{ tag: string }>;
    const difficulty = this.db
      .prepare("SELECT approved_value, reviewer_id FROM approved_difficulties WHERE problem_id = ?")
      .get(problemId) as { approved_value: number; reviewer_id: string } | undefined;
    const voteCount = this.db
      .prepare("SELECT COUNT(*) AS count FROM difficulty_votes WHERE problem_id = ?")
      .get(problemId) as { count: number };

    return {
      problemId,
      discussions: discussions.map((row) => ({
        id: row.id,
        problemId: row.problem_id,
        authorId: row.author_id,
        markdown: redactPublicText(row.markdown),
        moderationState: row.moderation_state,
      })),
      approvedTags: tags.map((row) => row.tag),
      difficulty: difficulty ? { approvedValue: difficulty.approved_value, reviewerId: difficulty.reviewer_id } : null,
      voteCount: voteCount.count,
    };
  }

  createDiscussionPost(input: { problemId: string; authorId: string; markdown: string }): ApiDiscussionPost {
    this.getProblem(input.problemId);
    const rawMarkdown = input.markdown.trim();
    if (rawMarkdown.length === 0) throw badRequest("Discussion markdown is required.");
    if (/(?:raw\s*)?(?:chain[-\s]?of[-\s]?thought|\bcot\b)|hidden reasoning/i.test(rawMarkdown)) {
      throw badRequest("Discussion posts must not include raw reasoning.");
    }
    const markdown = redactPublicText(rawMarkdown);
    const id = stableId("discussion", `${input.problemId}-${input.authorId}-${sha256(markdown).slice(0, 12)}`);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO discussion_posts
          (id, problem_id, author_id, markdown, moderation_state)
         VALUES (?, ?, ?, ?, 'visible')`,
      )
      .run(id, input.problemId, input.authorId, markdown);
    return { id, problemId: input.problemId, authorId: input.authorId, markdown, moderationState: "visible" };
  }

  suggestTag(input: { targetId: string; targetType: "problem" | "recording"; tag: string; suggestedBy: string }): ApiTagSuggestion {
    const tag = input.tag.trim().toLowerCase();
    if (tag.length === 0) throw badRequest("Tag is required.");
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(tag)) throw badRequest("Tag must be lowercase alphanumeric or hyphenated.");
    if (input.targetType === "problem") {
      this.getProblem(input.targetId);
    } else {
      this.getPublicRecording(input.targetId);
    }
    const id = stableId("tag", `${input.targetType}-${input.targetId}-${tag}-${input.suggestedBy}`);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO tag_suggestions
          (id, target_id, target_type, tag, suggested_by, reviewer_decision, reviewer_id, reviewer_notes)
         VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL)`,
      )
      .run(id, input.targetId, input.targetType, tag, input.suggestedBy);
    const row = this.db
      .prepare("SELECT reviewer_decision FROM tag_suggestions WHERE id = ?")
      .get(id) as { reviewer_decision: "pending" | "approved" | "rejected" } | undefined;
    return { id, targetId: input.targetId, targetType: input.targetType, tag, reviewerDecision: row?.reviewer_decision ?? "pending" };
  }

  approveTagSuggestion(id: string, reviewerId: string): ApiTagSuggestion {
    const row = this.db
      .prepare("SELECT id, target_id, target_type, tag FROM tag_suggestions WHERE id = ? AND reviewer_decision = 'pending'")
      .get(id) as { id: string; target_id: string; target_type: "problem" | "recording"; tag: string } | undefined;
    if (!row) throw notFound(`Unknown pending tag suggestion id: ${id}`);
    this.db
      .prepare("UPDATE tag_suggestions SET reviewer_decision = 'approved', reviewer_id = ?, reviewer_notes = ? WHERE id = ?")
      .run(reviewerId, "Trusted reviewer approved this community tag.", id);
    return { id: row.id, targetId: row.target_id, targetType: row.target_type, tag: row.tag, reviewerDecision: "approved" };
  }

  voteDifficulty(input: { problemId: string; voterId: string; value: number }): { problemId: string; voterId: string; value: number } {
    this.getProblem(input.problemId);
    if (!Number.isInteger(input.value) || input.value < 1 || input.value > 5) throw badRequest("Difficulty vote must be an integer from 1 to 5.");
    this.db
      .prepare(
        `INSERT INTO difficulty_votes (id, problem_id, voter_id, value)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(problem_id, voter_id) DO UPDATE SET value = excluded.value`,
      )
      .run(stableId("difficulty-vote", `${input.problemId}-${input.voterId}`), input.problemId, input.voterId, input.value);
    return input;
  }

  approveDifficulty(problemId: string, reviewerId: string): { problemId: string; approvedValue: number; reviewerId: string; voteCount: number } {
    this.getProblem(problemId);
    const row = this.db
      .prepare("SELECT COUNT(*) AS count, AVG(value) AS average FROM difficulty_votes WHERE problem_id = ?")
      .get(problemId) as { count: number; average: number | null };
    if (row.count === 0 || row.average === null) throw badRequest("Difficulty approval requires at least one vote.");
    const approvedValue = Math.max(1, Math.min(5, Math.round(row.average)));
    this.db
      .prepare(
        `INSERT OR REPLACE INTO approved_difficulties
          (problem_id, approved_value, reviewer_id)
         VALUES (?, ?, ?)`,
      )
      .run(problemId, approvedValue, reviewerId);
    return { problemId, approvedValue, reviewerId, voteCount: row.count };
  }
  health(): { ok: true; sqlite: "open"; catalogProblems: number } {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM problems WHERE enabled = 1").get() as { count: number };
    return { ok: true, sqlite: "open", catalogProblems: row.count };
  }

  listProblems(): ApiProblemListItem[] {
    const rows = this.db
      .prepare(
        `SELECT p.id, p.title, p.benchmark_id, p.adapter_id, p.upstream_task_id, p.hosting_mode, p.language_framework_tags_json
         FROM problems p
         JOIN benchmarks b ON b.id = p.benchmark_id
         WHERE p.enabled = 1
           AND b.legal_status = 'approved'
           AND (p.hosting_mode = 'adapter-only' OR b.redistribution_rights = 'clear')
         ORDER BY p.id`,
      )
      .all() as Array<{
      id: string;
      title: string;
      benchmark_id: string;
      adapter_id: string;
      upstream_task_id: string;
      hosting_mode: string;
      language_framework_tags_json: string;
    }>;

    return rows.map((row) => {
      const catalogProblem = listImplementedProblemCatalogs().find((entry) => entry.problem.id === row.id)?.problem;
      return {
        id: row.id,
        title: row.title,
        benchmarkId: row.benchmark_id,
        adapterId: row.adapter_id,
        upstreamTaskId: row.upstream_task_id,
        hostingMode: row.hosting_mode,
        tags: JSON.parse(row.language_framework_tags_json) as string[],
        ...(catalogProblem?.scoringMode ? { scoringMode: catalogProblem.scoringMode } : {}),
        ...(catalogProblem?.oracleMetadata?.oracleDescriptorHash ? { oracleDescriptorHash: catalogProblem.oracleMetadata.oracleDescriptorHash } : {}),
      };
    });
  }

  getProblem(id: string): ApiProblemListItem {
    const problem = this.listProblems().find((item) => item.id === id);
    if (!problem) throw notFound(`Unknown problem id: ${id}`);
    return problem;
  }

  listRegistry(): ApiRegistryItem[] {
    return listAdapterRegistry().map((entry) => ({
      benchmarkId: entry.benchmark.id,
      name: entry.benchmark.name,
      licenseId: entry.benchmark.licenseId,
      legalStatus: entry.benchmark.legalStatus,
      redistributionRights: entry.benchmark.redistributionRights,
      defaultHostingMode: entry.benchmark.defaultHostingMode,
      status: entry.status,
      dataPolicy: entry.dataPolicy,
    }));
  }

  listLeaderboard(): ApiLeaderboardEntry[] {
    const rows = this.db
      .prepare(
        `SELECT le.id, le.problem_id, le.submission_id, le.reproducible_result, le.public_metrics_json, le.eligibility_status, le.ineligibility_reason,
                s.patch_stats_json,
                rr.id AS runner_result_id, rr.job_id, rr.patch_apply_status, rr.exit_code, rr.pass_fail, rr.runtime_ms,
                rr.memory_peak_mb, rr.stdout_ref, rr.stderr_ref, rr.result_hash
         FROM leaderboard_entries le
         JOIN submissions s ON s.id = le.submission_id
         JOIN runner_jobs j ON j.submission_id = le.submission_id
         JOIN runner_results rr ON rr.job_id = j.id
         JOIN solution_recordings sr ON sr.submission_id = le.submission_id
         JOIN evidence_ledgers e ON e.recording_id = sr.id
         JOIN runner_jobs oj ON oj.id = sr.original_job_id
         JOIN runner_results orr ON orr.id = sr.original_result_id AND orr.job_id = oj.id
         JOIN runner_jobs rj ON rj.id = e.rerun_job_id
         JOIN runner_results rrr ON rrr.id = e.rerun_result_id AND rrr.job_id = rj.id
         WHERE le.eligibility_status = 'eligible'
           AND j.id = sr.original_job_id
           AND rr.id = sr.original_result_id
           AND sr.scoring_status = 'scored'
           AND sr.oracle_descriptor_hash IS NOT NULL
           AND sr.oracle_descriptor_hash = e.oracle_descriptor_hash
           AND e.required_field_check = 'pass'
           AND e.patch_clean_apply_check = 'pass'
           AND e.verification_exit_zero_check = 'pass'
           AND e.sandbox_rerun_check = 'pass'
           AND e.original_job_id = sr.original_job_id
           AND e.original_result_id = sr.original_result_id
           AND e.original_result_hash = sr.original_result_hash
           AND e.rerun_job_id <> sr.original_job_id
           AND e.rerun_result_id <> sr.original_result_id
           AND e.rerun_result_hash <> sr.original_result_hash
           AND oj.scoring_status = 'scored'
           AND oj.sandbox_mode = 'docker'
           AND oj.oracle_descriptor_hash = sr.oracle_descriptor_hash
           AND rj.scoring_status = 'scored'
           AND rj.sandbox_mode = 'docker'
           AND rj.oracle_descriptor_hash = sr.oracle_descriptor_hash
           AND orr.result_hash = sr.original_result_hash
           AND rrr.result_hash = e.rerun_result_hash
         ORDER BY le.id`
      )
      .all() as Array<{
        id: string;
        problem_id: string;
        submission_id: string;
        reproducible_result: number;
        patch_stats_json: string;
        public_metrics_json: string;
        eligibility_status: string;
        ineligibility_reason: string | null;
        runner_result_id: string;
        job_id: string;
        patch_apply_status: RunnerResult["patchApplyStatus"];
        exit_code: number;
        pass_fail: "pass" | "fail";
        runtime_ms: number;
        memory_peak_mb: number | null;
        stdout_ref: string;
        stderr_ref: string;
        result_hash: string;
      }>;

    return rows.flatMap((row) => {
      const metrics = parsePublicMetricsJson(row.public_metrics_json);
      if (metrics.passFail !== "pass") return [];
      const entry: LeaderboardEntry = {
        id: row.id,
        problemId: row.problem_id,
        submissionId: row.submission_id,
        reproducibleResult: row.reproducible_result === 1,
        publicMetrics: metrics,
        eligibilityStatus: "eligible",
        ineligibilityReason: row.ineligibility_reason ?? undefined,
      };
      const runnerResult: RunnerResult = {
        id: row.runner_result_id,
        jobId: row.job_id,
        patchApplyStatus: row.patch_apply_status,
        exitCode: row.exit_code,
        passFail: row.pass_fail,
        runtimeMs: row.runtime_ms,
        memoryPeakMb: row.memory_peak_mb,
        stdoutRef: row.stdout_ref,
        stderrRef: row.stderr_ref,
        resultHash: row.result_hash,
      };
      if (!isLeaderboardEligible(entry, runnerResult).ok) return [];
      const patchStats = JSON.parse(row.patch_stats_json) as PatchSubmission["patchStats"];
      if (!publicMetricsMatchPatchStats(metrics, patchStats).ok) return [];
      const dto = {
        id: row.id,
        problemId: row.problem_id,
        submissionId: row.submission_id,
        ...metrics,
        eligibilityStatus: row.eligibility_status,
        ineligibilityReason: row.ineligibility_reason ? redactPublicText(row.ineligibility_reason) : undefined,
      };
      const safe = safePublicDto(dto, `leaderboard:${row.id}`);
      return safe ? [safe] : [];
    });
  }

  listPublicRecordings(): ApiRecordingSummary[] {
    const rows = this.db
      .prepare(
        `SELECT r.id, r.problem_id, r.summary, r.root_cause, r.fix_description, pm.public_slug
         FROM solution_recordings r
         JOIN evidence_ledgers e ON e.recording_id = r.id
         JOIN review_gates rg ON rg.recording_id = r.id
         JOIN public_memory_entries pm ON pm.recording_id = r.id
         JOIN runner_jobs oj ON oj.id = r.original_job_id
         JOIN runner_results orr ON orr.id = r.original_result_id AND orr.job_id = oj.id
         JOIN runner_jobs rj ON rj.id = e.rerun_job_id
         JOIN runner_results rrr ON rrr.id = e.rerun_result_id AND rrr.job_id = rj.id
         WHERE e.required_field_check = 'pass'
           AND e.patch_clean_apply_check = 'pass'
           AND e.verification_exit_zero_check = 'pass'
           AND e.sandbox_rerun_check = 'pass'
           AND rg.automatic_check_status = 'pass'
           AND rg.trusted_reviewer_approval_status = 'approved'
           AND r.scoring_status = 'scored'
           AND r.oracle_descriptor_hash IS NOT NULL
           AND r.oracle_descriptor_hash = e.oracle_descriptor_hash
           AND e.original_job_id = r.original_job_id
           AND e.original_result_id = r.original_result_id
           AND e.original_result_hash = r.original_result_hash
           AND e.rerun_job_id <> r.original_job_id
           AND e.rerun_result_id <> r.original_result_id
           AND e.rerun_result_hash <> r.original_result_hash
           AND oj.scoring_status = 'scored'
           AND oj.sandbox_mode = 'docker'
           AND oj.oracle_descriptor_hash = r.oracle_descriptor_hash
           AND rj.scoring_status = 'scored'
           AND rj.sandbox_mode = 'docker'
           AND rj.oracle_descriptor_hash = r.oracle_descriptor_hash
           AND orr.result_hash = r.original_result_hash
           AND rrr.result_hash = e.rerun_result_hash
         ORDER BY r.id`,
      )
      .all() as Array<{
      id: string;
      problem_id: string;
      summary: string;
      root_cause: string;
      fix_description: string;
      public_slug: string;
    }>;

    return rows.flatMap((row) => {
      if (!isPublicSlug(row.public_slug)) return [];
      const dto = {
        id: row.id,
        problemId: row.problem_id,
        summary: redactPublicText(row.summary),
        rootCause: redactPublicText(row.root_cause),
        fixDescription: redactPublicText(row.fix_description),
        publicSlug: row.public_slug,
      };
      const safe = safePublicDto(dto, `recording:${row.id}`);
      return safe ? [safe] : [];
    });
  }

  getPublicRecording(id: string): ApiRecordingSummary {
    const recording = this.listPublicRecordings().find((item) => item.id === id);
    if (!recording) throw notFound(`Unknown public recording id: ${id}`);
    return recording;
  }

  searchPublicMemory(query: { errorSignature: string; languageFramework: string }): ApiMemorySearchResult[] {
    const rows = this.db
      .prepare(
        `SELECT pm.public_slug, c.error_signature, c.language_framework, c.action_checklist_json, c.source_recording_ids_json
         FROM checklist_cases c
         JOIN public_memory_entries pm ON pm.id = c.public_memory_entry_id
         JOIN solution_recordings r ON r.id = c.recording_id
         JOIN evidence_ledgers e ON e.recording_id = r.id
         JOIN review_gates rg ON rg.recording_id = r.id
         JOIN runner_jobs oj ON oj.id = r.original_job_id
         JOIN runner_results orr ON orr.id = r.original_result_id AND orr.job_id = oj.id
         JOIN runner_jobs rj ON rj.id = e.rerun_job_id
         JOIN runner_results rrr ON rrr.id = e.rerun_result_id AND rrr.job_id = rj.id
         WHERE lower(c.language_framework) = lower(?)
           AND (lower(c.error_signature) LIKE '%' || lower(?) || '%' OR lower(?) LIKE '%' || lower(c.error_signature) || '%')
           AND e.required_field_check = 'pass'
           AND e.patch_clean_apply_check = 'pass'
           AND e.verification_exit_zero_check = 'pass'
           AND e.sandbox_rerun_check = 'pass'
           AND rg.automatic_check_status = 'pass'
           AND rg.trusted_reviewer_approval_status = 'approved'
           AND r.scoring_status = 'scored'
           AND r.oracle_descriptor_hash IS NOT NULL
           AND r.oracle_descriptor_hash = e.oracle_descriptor_hash
           AND e.original_job_id = r.original_job_id
           AND e.original_result_id = r.original_result_id
           AND e.original_result_hash = r.original_result_hash
           AND e.rerun_job_id <> r.original_job_id
           AND e.rerun_result_id <> r.original_result_id
           AND e.rerun_result_hash <> r.original_result_hash
           AND oj.scoring_status = 'scored'
           AND oj.sandbox_mode = 'docker'
           AND oj.oracle_descriptor_hash = r.oracle_descriptor_hash
           AND rj.scoring_status = 'scored'
           AND rj.sandbox_mode = 'docker'
           AND rj.oracle_descriptor_hash = r.oracle_descriptor_hash
           AND orr.result_hash = r.original_result_hash
           AND rrr.result_hash = e.rerun_result_hash
         ORDER BY c.id`,
      )
      .all(query.languageFramework, query.errorSignature, query.errorSignature) as Array<{
      public_slug: string;
      error_signature: string;
      language_framework: string;
      action_checklist_json: string;
      source_recording_ids_json: string;
    }>;

    return rows.flatMap((row) => {
      if (!isPublicSlug(row.public_slug)) return [];
      const actionChecklist = parsePublicStringArray(row.action_checklist_json);
      const sourceRecordingIds = parsePublicStringArray(row.source_recording_ids_json);
      if (!actionChecklist || !sourceRecordingIds) return [];
      const errorSignature = redactPublicText(row.error_signature);
      const languageFramework = redactPublicText(row.language_framework);
      const dto = {
        publicRecordingLink: row.public_slug,
        errorSignature,
        languageFramework,
        actionChecklist: actionChecklist.map(redactPublicText),
        sourceRecordingIds,
        applicabilityExplanation: `Matched ${languageFramework} case for ${errorSignature}.`,
      };
      const safe = safePublicDto(dto, `memory:${row.public_slug}`);
      return safe ? [safe] : [];
    });
  }
}

export function withAgentOjRepository<T>(path: string, fn: (repository: AgentOjRepository) => T): T {
  const repository = AgentOjRepository.open(path);
  try {
    return fn(repository);
  } finally {
    repository.close();
  }
}
