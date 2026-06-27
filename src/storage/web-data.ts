import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertPublicPayloadSafe, isPublicSlug, redactPublicText } from "../public-redaction.ts";
import { isLeaderboardEligible, parsePublicMetricsJson, publicMetricsMatchPatchStats } from "../contracts/validators.ts";
import { listAdapterRegistry, listImplementedProblemCatalogs } from "../adapters/registry.ts";
import { openAgentOjDatabase } from "./sqlite-store.ts";
import type { LeaderboardEntry, PatchSubmission, RunnerResult } from "../contracts/types.ts";


export interface WebProblemData {
  id: string;
  title: string;
  benchmarkId: string;
  benchmark: string;
  upstreamTaskId: string;
  hostingMode: string;
  tags: readonly string[];
}

export interface WebDataBundle {
  problems: WebProblemData[];
  registry: Array<{ benchmarkId: string; name: string; licenseId: string; legalStatus: string; redistributionRights: string; status: string; dataPolicy: string }>;
  leaderboard: Array<{ id: string; problemId: string; submissionId: string; passFail: string; runtimeMs: number; filesChanged: number; locAdded: number; locDeleted: number; eligibilityStatus: string; ineligibilityReason?: string }>;
  recordings: Array<{ id: string; problemId: string; summary: string; rootCause: string; fixDescription: string; publicSlug: string }>;
  memory: Array<{ publicRecordingLink: string; errorSignature: string; languageFramework: string; actionChecklist: string[]; sourceRecordingIds: string[] }>;
}

function seedProblems(): WebProblemData[] {
  return listImplementedProblemCatalogs().map(({ benchmark, problem }) => ({
    id: problem.id,
    title: problem.title,
    benchmarkId: problem.benchmarkId,
    benchmark: benchmark.name,
    upstreamTaskId: problem.upstreamTaskId,
    hostingMode: problem.hostingMode,
    tags: problem.languageFrameworkTags,
  }));
}

function seedRegistry(): WebDataBundle["registry"] {
  return listAdapterRegistry().map((entry) => ({
    benchmarkId: entry.benchmark.id,
    name: entry.benchmark.name,
    licenseId: entry.benchmark.licenseId,
    legalStatus: entry.benchmark.legalStatus,
    redistributionRights: entry.benchmark.redistributionRights,
    status: entry.status,
    dataPolicy: entry.dataPolicy,
  }));
}
function parseStringArray(jsonText: string): string[] | null {
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


export function createWebDataBundle(dbPath?: string): WebDataBundle {
  const bundle: WebDataBundle = {
    problems: seedProblems(),
    registry: seedRegistry(),
    leaderboard: [],
    recordings: [],
    memory: [],
  };

  if (!dbPath) return bundle;

  const db = openAgentOjDatabase(dbPath);
  try {
    bundle.leaderboard = db
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
      .all()
      .flatMap((row) => {
        const typed = row as {
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
        };
        const metrics = parsePublicMetricsJson(typed.public_metrics_json);
        if (metrics.passFail !== "pass") return [];
        const entry: LeaderboardEntry = {
          id: typed.id,
          problemId: typed.problem_id,
          submissionId: typed.submission_id,
          reproducibleResult: typed.reproducible_result === 1,
          publicMetrics: metrics,
          eligibilityStatus: "eligible",
          ineligibilityReason: typed.ineligibility_reason ?? undefined,
        };
        const runnerResult: RunnerResult = {
          id: typed.runner_result_id,
          jobId: typed.job_id,
          patchApplyStatus: typed.patch_apply_status,
          exitCode: typed.exit_code,
          passFail: typed.pass_fail,
          runtimeMs: typed.runtime_ms,
          memoryPeakMb: typed.memory_peak_mb,
          stdoutRef: typed.stdout_ref,
          stderrRef: typed.stderr_ref,
          resultHash: typed.result_hash,
        };
        if (!isLeaderboardEligible(entry, runnerResult).ok) return [];
        const patchStats = JSON.parse(typed.patch_stats_json) as PatchSubmission["patchStats"];
        if (!publicMetricsMatchPatchStats(metrics, patchStats).ok) return [];
        const dto = {
          id: typed.id,
          problemId: typed.problem_id,
          submissionId: typed.submission_id,
          ...metrics,
          eligibilityStatus: typed.eligibility_status,
          ineligibilityReason: typed.ineligibility_reason ?? undefined,
        };
        const safe = safePublicDto(dto, `leaderboard:${typed.id}`);
        return safe ? [safe] : [];
      });


    bundle.recordings = db
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
      .all()
      .map((row) => {
        const typed = row as {
          id: string;
          problem_id: string;
          summary: string;
          root_cause: string;
          fix_description: string;
          public_slug: string;
        };
        if (!isPublicSlug(typed.public_slug)) return null;
        return safePublicDto(
          {
            id: typed.id,
            problemId: typed.problem_id,
            summary: redactPublicText(typed.summary),
            rootCause: redactPublicText(typed.root_cause),
            fixDescription: redactPublicText(typed.fix_description),
            publicSlug: typed.public_slug,
          },
          `recording:${typed.id}`,
        );
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);


    bundle.memory = db
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
         ORDER BY c.id`,
      )
      .all()
      .map((row) => {
        const typed = row as {
          public_slug: string;
          error_signature: string;
          language_framework: string;
          action_checklist_json: string;
          source_recording_ids_json: string;
        };
        if (!isPublicSlug(typed.public_slug)) return null;
        const actionChecklist = parseStringArray(typed.action_checklist_json);
        const sourceRecordingIds = parseStringArray(typed.source_recording_ids_json);
        if (!actionChecklist || !sourceRecordingIds) return null;
        return safePublicDto(
          {
            publicRecordingLink: typed.public_slug,
            errorSignature: redactPublicText(typed.error_signature),
            languageFramework: typed.language_framework,
            actionChecklist: actionChecklist.map(redactPublicText),
            sourceRecordingIds,
          },
          `memory:${typed.public_slug}`,
        );
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  } finally {
    db.close();
  }

  assertPublicPayloadSafe(bundle, "web-data-bundle");
  return bundle;
}

export function exportWebData(outDir: string, dbPath?: string): string[] {
  mkdirSync(outDir, { recursive: true });
  const bundle = createWebDataBundle(dbPath);
  const files: Array<[string, unknown]> = [
    ["problems.json", bundle.problems],
    ["registry.json", bundle.registry],
    ["leaderboard.json", bundle.leaderboard],
    ["recordings.json", bundle.recordings],
    ["memory.json", bundle.memory],
  ];
  return files.map(([name, value]) => {
    const path = join(outDir, name);
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return path;
  });
}
