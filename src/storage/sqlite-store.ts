import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { Adapter, Benchmark, PatchSubmission, Problem, RunnerJob, RunnerResult } from "../contracts/types.ts";
import { assertPublicPayloadSafe, isPublicSlug, redactPublicMarkdown, redactPublicText } from "../public-redaction.ts";
import type { RunBundle } from "./run-store.ts";

export interface FailedRunBundle {
  schemaVersion: 1;
  recordedAt: string;
  benchmark: Benchmark;
  adapter: Adapter;
  problem: Problem;
  submission: PatchSubmission;
  runnerJob: RunnerJob;
  runnerResult: RunnerResult;
  error: string;
}

export interface SqlitePersistResult {
  path: string;
  inserted: {
    benchmark: string;
    adapter: string;
    problem: string;
    submission: string;
    runnerJob: string;
    runnerResult: string;
    recording?: string;
    evidence?: string;
    review?: string;
    publicMemory?: string;
    leaderboard?: string;
  };
}

const schemaPath = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "schemas", "sqlite.sql");
type RunBundleWithRerun = RunBundle & {
  rerunRunnerJob?: RunnerJob;
  rerunRunnerResult?: RunnerResult;
};


function json(value: unknown): string {
  return JSON.stringify(value);
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

export function createFailedRunBundle(
  input: Omit<FailedRunBundle, "schemaVersion" | "recordedAt">,
  recordedAt = new Date().toISOString(),
): FailedRunBundle {
  return {
    schemaVersion: 1,
    recordedAt,
    ...input,
  };
}

export function openAgentOjDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(schemaPath, "utf8"));
  for (const statement of [
    "ALTER TABLE runner_jobs ADD COLUMN scoring_status TEXT NOT NULL DEFAULT 'demo' CHECK (scoring_status IN ('demo', 'scored'))",
    "ALTER TABLE runner_jobs ADD COLUMN sandbox_mode TEXT NOT NULL DEFAULT 'local' CHECK (sandbox_mode IN ('local', 'docker'))",
    "ALTER TABLE runner_jobs ADD COLUMN oracle_descriptor_hash TEXT",
    "ALTER TABLE solution_recordings ADD COLUMN scoring_status TEXT NOT NULL DEFAULT 'demo' CHECK (scoring_status IN ('demo', 'scored'))",
    "ALTER TABLE solution_recordings ADD COLUMN original_job_id TEXT",
    "ALTER TABLE solution_recordings ADD COLUMN original_result_id TEXT",
    "ALTER TABLE solution_recordings ADD COLUMN original_result_hash TEXT",
    "ALTER TABLE solution_recordings ADD COLUMN oracle_descriptor_hash TEXT",
    "ALTER TABLE evidence_ledgers ADD COLUMN original_job_id TEXT",
    "ALTER TABLE evidence_ledgers ADD COLUMN original_result_id TEXT",
    "ALTER TABLE evidence_ledgers ADD COLUMN original_result_hash TEXT",
    "ALTER TABLE evidence_ledgers ADD COLUMN rerun_result_id TEXT",
    "ALTER TABLE evidence_ledgers ADD COLUMN rerun_result_hash TEXT",
    "ALTER TABLE evidence_ledgers ADD COLUMN oracle_descriptor_hash TEXT",
  ]) {
    try {
      db.exec(statement);
    } catch {
      // Column already exists on databases created with the current schema.
    }
  }
  return db;
}

function insertCatalog(db: DatabaseSync, benchmark: Benchmark, adapter: Adapter, problem: Problem): void {
  db.prepare(
    `INSERT OR IGNORE INTO benchmarks
      (id, name, upstream_url, upstream_commit_or_version, license_id, legal_status, redistribution_rights, default_hosting_mode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    benchmark.id,
    benchmark.name,
    benchmark.upstreamUrl,
    benchmark.upstreamCommitOrVersion,
    benchmark.licenseId,
    benchmark.legalStatus,
    benchmark.redistributionRights,
    benchmark.defaultHostingMode,
  );

  db.prepare(
    `INSERT OR IGNORE INTO adapters
      (id, benchmark_id, adapter_version, fetch_strategy, judge_command_json, verification_commands_json, supported_hosting_modes_json, docker_image_digest, resources_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    adapter.id,
    adapter.benchmarkId,
    adapter.adapterVersion,
    adapter.fetchStrategy,
    json(adapter.judgeCommand),
    json(adapter.verificationCommands),
    json(adapter.supportedHostingModes),
    adapter.dockerImageDigest,
    json(adapter.defaultResources),
  );

  db.prepare(
    `INSERT OR IGNORE INTO problems
      (id, benchmark_id, adapter_id, upstream_task_id, title, language_framework_tags_json, hosting_mode, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    problem.id,
    problem.benchmarkId,
    problem.adapterId,
    problem.upstreamTaskId,
    problem.title,
    json(problem.languageFrameworkTags),
    problem.hostingMode,
    problem.enabled ? 1 : 0,
  );
}

function insertSubmissionAndResult(db: DatabaseSync, bundle: FailedRunBundle | RunBundle): void {
  db.prepare(
    `INSERT OR REPLACE INTO submissions
      (id, user_id, problem_id, patch_sha256, patch_stats_json, supplied_metrics_json, visibility, public_metrics_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    bundle.submission.id,
    bundle.submission.userId,
    bundle.submission.problemId,
    bundle.submission.patchSha256,
    json(bundle.submission.patchStats),
    bundle.submission.suppliedMetrics ? json(bundle.submission.suppliedMetrics) : null,
    bundle.submission.visibility,
    json(bundle.submission.publicMetrics),
  );

  db.prepare(
    `INSERT OR REPLACE INTO runner_jobs
      (id, submission_id, adapter_id, upstream_commit, docker_image_digest, resources_json, status, scoring_status, sandbox_mode, oracle_descriptor_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    bundle.runnerJob.id,
    bundle.runnerJob.submissionId,
    bundle.runnerJob.adapterId,
    bundle.runnerJob.upstreamCommit,
    bundle.runnerJob.dockerImageDigest,
    json(bundle.runnerJob.resources),
    bundle.runnerJob.status,
    bundle.runnerJob.scoringStatus,
    bundle.runnerJob.sandboxMode,
    bundle.runnerJob.oracleDescriptorHash,
  );

  db.prepare(
    `INSERT OR REPLACE INTO runner_results
      (id, job_id, patch_apply_status, exit_code, pass_fail, runtime_ms, memory_peak_mb, stdout_ref, stderr_ref, result_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    bundle.runnerResult.id,
    bundle.runnerResult.jobId,
    bundle.runnerResult.patchApplyStatus,
    bundle.runnerResult.exitCode,
    bundle.runnerResult.passFail,
    bundle.runnerResult.runtimeMs,
    bundle.runnerResult.memoryPeakMb,
    bundle.runnerResult.stdoutRef,
    bundle.runnerResult.stderrRef,
    bundle.runnerResult.resultHash,
  );
}

export function persistFailedRunToSqlite(path: string, bundle: FailedRunBundle): SqlitePersistResult {
  const db = openAgentOjDatabase(path);
  try {
    db.exec("BEGIN");
    insertCatalog(db, bundle.benchmark, bundle.adapter, bundle.problem);
    insertSubmissionAndResult(db, bundle);
    db.prepare(
      `INSERT OR REPLACE INTO failed_run_attempts
        (id, submission_id, problem_id, runner_job_id, runner_result_id, error)
        VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      `failed-${bundle.submission.id}`,
      bundle.submission.id,
      bundle.problem.id,
      bundle.runnerJob.id,
      bundle.runnerResult.id,
      bundle.error,
    );
    db.exec("COMMIT");
    return {
      path,
      inserted: {
        benchmark: bundle.benchmark.id,
        adapter: bundle.adapter.id,
        problem: bundle.problem.id,
        submission: bundle.submission.id,
        runnerJob: bundle.runnerJob.id,
        runnerResult: bundle.runnerResult.id,
      },
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

export function persistRunBundleToSqlite(path: string, bundle: RunBundleWithRerun): SqlitePersistResult {
  if (
    bundle.recording.scoringStatus !== "scored" ||
    bundle.runnerJob.scoringStatus !== "scored" ||
    bundle.runnerJob.sandboxMode !== "docker" ||
    !bundle.recording.oracleDescriptorHash ||
    bundle.runnerJob.oracleDescriptorHash !== bundle.recording.oracleDescriptorHash ||
    bundle.evidence.oracleDescriptorHash !== bundle.recording.oracleDescriptorHash ||
    bundle.evidence.rerunJobId === bundle.runnerJob.id ||
    bundle.evidence.rerunResultId === bundle.runnerResult.id ||
    bundle.evidence.rerunResultHash === bundle.runnerResult.resultHash
  ) {
    throw new Error("Public run bundle persistence requires scored Docker oracle evidence with a distinct rerun.");
  }
  const db = openAgentOjDatabase(path);
  try {
    db.exec("BEGIN");
    insertCatalog(db, bundle.benchmark, bundle.adapter, bundle.problem);
    insertSubmissionAndResult(db, bundle);
    if (bundle.evidence.rerunJobId !== bundle.runnerJob.id) {
      if (
        !bundle.rerunRunnerJob ||
        !bundle.rerunRunnerResult ||
        bundle.rerunRunnerJob.id !== bundle.evidence.rerunJobId ||
        bundle.rerunRunnerResult.id !== bundle.evidence.rerunResultId ||
        bundle.rerunRunnerResult.jobId !== bundle.rerunRunnerJob.id ||
        bundle.rerunRunnerResult.resultHash !== bundle.evidence.rerunResultHash
      ) {
        throw new Error("Distinct rerun evidence must include the stored executed rerun job and result.");
      }
      db.prepare(
        `INSERT OR REPLACE INTO runner_jobs
          (id, submission_id, adapter_id, upstream_commit, docker_image_digest, resources_json, status, scoring_status, sandbox_mode, oracle_descriptor_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        bundle.rerunRunnerJob.id,
        bundle.rerunRunnerJob.submissionId,
        bundle.rerunRunnerJob.adapterId,
        bundle.rerunRunnerJob.upstreamCommit,
        bundle.rerunRunnerJob.dockerImageDigest,
        json(bundle.rerunRunnerJob.resources),
        bundle.rerunRunnerJob.status,
        bundle.rerunRunnerJob.scoringStatus,
        bundle.rerunRunnerJob.sandboxMode,
        bundle.rerunRunnerJob.oracleDescriptorHash,
      );
      db.prepare(
        `INSERT OR REPLACE INTO runner_results
          (id, job_id, patch_apply_status, exit_code, pass_fail, runtime_ms, memory_peak_mb, stdout_ref, stderr_ref, result_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        bundle.rerunRunnerResult.id,
        bundle.rerunRunnerResult.jobId,
        bundle.rerunRunnerResult.patchApplyStatus,
        bundle.rerunRunnerResult.exitCode,
        bundle.rerunRunnerResult.passFail,
        bundle.rerunRunnerResult.runtimeMs,
        bundle.rerunRunnerResult.memoryPeakMb,
        bundle.rerunRunnerResult.stdoutRef,
        bundle.rerunRunnerResult.stderrRef,
        bundle.rerunRunnerResult.resultHash,
      );
    }

    db.prepare(
      `INSERT OR REPLACE INTO solution_recordings
        (id, submission_id, problem_id, benchmark_id, upstream_commit, docker_image_digest, resources_json,
         final_patch_sha256, pass_fail, loc_delta_json, token_metrics_json, summary, root_cause, fix_description,
         verification_commands_json, evidence_ledger_id, schema_version, immutable, scoring_status, original_job_id,
         original_result_id, original_result_hash, oracle_descriptor_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      bundle.recording.id,
      bundle.recording.submissionId,
      bundle.recording.problemId,
      bundle.recording.benchmarkId,
      bundle.recording.upstreamCommit,
      bundle.recording.dockerImageDigest,
      json(bundle.recording.resources),
      bundle.recording.finalPatchSha256,
      bundle.recording.passFail,
      json(bundle.recording.locDelta),
      bundle.recording.tokenMetrics ? json(bundle.recording.tokenMetrics) : null,
      bundle.recording.summary,
      bundle.recording.rootCause,
      bundle.recording.fixDescription,
      json(bundle.recording.verificationCommands),
      bundle.recording.evidenceLedgerId,
      bundle.recording.schemaVersion,
      bundle.recording.immutable ? 1 : 0,
      bundle.recording.scoringStatus,
      bundle.recording.originalJobId,
      bundle.recording.originalResultId,
      bundle.recording.originalResultHash,
      bundle.recording.oracleDescriptorHash,
    );

    db.prepare(
      `INSERT OR REPLACE INTO evidence_ledgers
        (id, recording_id, required_field_check, patch_clean_apply_check, verification_exit_zero_check,
         sandbox_rerun_check, rerun_job_id, original_job_id, original_result_id, original_result_hash,
         rerun_result_id, rerun_result_hash, oracle_descriptor_hash, checker_version, evidence_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      bundle.evidence.id,
      bundle.evidence.recordingId,
      bundle.evidence.requiredFieldCheck,
      bundle.evidence.patchCleanApplyCheck,
      bundle.evidence.verificationExitZeroCheck,
      bundle.evidence.sandboxRerunCheck,
      bundle.evidence.rerunJobId,
      bundle.evidence.originalJobId,
      bundle.evidence.originalResultId,
      bundle.evidence.originalResultHash,
      bundle.evidence.rerunResultId,
      bundle.evidence.rerunResultHash,
      bundle.evidence.oracleDescriptorHash,
      bundle.evidence.checkerVersion,
      bundle.evidence.evidenceHash,
    );

    db.prepare(
      `INSERT OR REPLACE INTO review_gates
        (id, recording_id, automatic_check_status, trusted_reviewer_approval_status, reviewer_id, reviewer_notes)
        VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      bundle.review.id,
      bundle.review.recordingId,
      bundle.review.automaticCheckStatus,
      bundle.review.trustedReviewerApprovalStatus,
      bundle.review.reviewerId ?? null,
      bundle.review.reviewerNotes ?? null,
    );

    db.prepare(
      `INSERT OR REPLACE INTO public_memory_entries
        (id, recording_id, public_slug, source_checklist_case_ids_json)
        VALUES (?, ?, ?, ?)`,
    ).run(
      bundle.publicMemory.id,
      bundle.publicMemory.recordingId,
      bundle.publicMemory.publicSlug,
      json(bundle.publicMemory.sourceChecklistCaseIds),
    );

    db.prepare(
      `INSERT OR REPLACE INTO checklist_cases
        (id, public_memory_entry_id, recording_id, language_framework, error_signature, action_checklist_json, source_recording_ids_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      bundle.publicMemory.sourceChecklistCaseIds[0] ?? `checklist-${bundle.recording.id}`,
      bundle.publicMemory.id,
      bundle.recording.id,
      bundle.problem.languageFrameworkTags[0] ?? "unknown",
      bundle.recording.rootCause,
      json([bundle.recording.fixDescription, ...bundle.recording.verificationCommands.map((command) => command.join(" "))]),
      json([bundle.recording.id]),
    );

    db.prepare(
      `INSERT OR REPLACE INTO leaderboard_entries
        (id, submission_id, problem_id, reproducible_result, public_metrics_json, eligibility_status, ineligibility_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      bundle.leaderboard.id,
      bundle.leaderboard.submissionId,
      bundle.leaderboard.problemId,
      bundle.leaderboard.reproducibleResult ? 1 : 0,
      json(bundle.leaderboard.publicMetrics),
      bundle.leaderboard.eligibilityStatus,
      bundle.leaderboard.ineligibilityReason ?? null,
    );
    db.exec("COMMIT");

    return {
      path,
      inserted: {
        benchmark: bundle.benchmark.id,
        adapter: bundle.adapter.id,
        problem: bundle.problem.id,
        submission: bundle.submission.id,
        runnerJob: bundle.runnerJob.id,
        runnerResult: bundle.runnerResult.id,
        recording: bundle.recording.id,
        evidence: bundle.evidence.id,
        review: bundle.review.id,
        publicMemory: bundle.publicMemory.id,
        leaderboard: bundle.leaderboard.id,
      },
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

export function exportRecordingMarkdownFromSqlite(path: string, recordingId: string): string {
  const db = openAgentOjDatabase(path);
  try {
    const row = db
      .prepare(
        `SELECT r.id, r.summary, r.root_cause, r.fix_description, r.verification_commands_json,
                r.final_patch_sha256, r.pass_fail, p.id AS problem_id, p.title AS problem_title,
                e.evidence_hash, pm.public_slug
         FROM solution_recordings r
         JOIN problems p ON p.id = r.problem_id
         JOIN evidence_ledgers e ON e.recording_id = r.id
         JOIN review_gates rg ON rg.recording_id = r.id
         JOIN public_memory_entries pm ON pm.recording_id = r.id
         JOIN runner_jobs oj ON oj.id = r.original_job_id
         JOIN runner_results orr ON orr.id = r.original_result_id AND orr.job_id = oj.id
         JOIN runner_jobs rj ON rj.id = e.rerun_job_id
         JOIN runner_results rrr ON rrr.id = e.rerun_result_id AND rrr.job_id = rj.id
         WHERE r.id = ?
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
           AND rrr.result_hash = e.rerun_result_hash`,
      )
      .get(recordingId) as
      | {
          id: string;
          summary: string;
          root_cause: string;
          fix_description: string;
          verification_commands_json: string;
          final_patch_sha256: string;
          pass_fail: string;
          problem_id: string;
          problem_title: string;
          evidence_hash: string;
          public_slug: string;
        }
      | undefined;
    if (!row) throw new Error(`Unknown recording id: ${recordingId}`);
    const commands = JSON.parse(row.verification_commands_json) as string[][];
    return [
      `# Solution Recording: ${redactPublicMarkdown(row.id)}`,
      "",
      "## Problem",
      `- ID: ${redactPublicMarkdown(row.problem_id)}`,
      `- Title: ${redactPublicMarkdown(row.problem_title)}`,
      "",
      "## Summary",
      redactPublicMarkdown(row.summary),
      "",
      "## Root Cause",
      redactPublicMarkdown(row.root_cause),
      "",
      "## Fix",
      redactPublicMarkdown(row.fix_description),
      "",
      "## Verification",
      ...commands.map((command) => `- ${redactPublicMarkdown(command.join(" "))}`),
      "",
      "## Evidence",
      `- Result: ${redactPublicMarkdown(row.pass_fail)}`,
      `- Patch: ${redactPublicMarkdown(row.final_patch_sha256)}`,
      `- Evidence: ${redactPublicMarkdown(row.evidence_hash)}`,
      `- Public memory: ${redactPublicMarkdown(row.public_slug)}`,
      "",
      "_This is a post-hoc evidence-backed recording. It does not contain raw chain-of-thought._",
    ].join("\n");
  } finally {
    db.close();
  }
}

export function searchSqlitePublicMemory(
  path: string,
  query: { errorSignature: string; languageFramework: string },
): Array<{ publicRecordingLink: string; actionChecklist: string[]; sourceRecordingIds: string[]; applicabilityExplanation: string }> {
  const db = openAgentOjDatabase(path);
  try {
    const rows = db
      .prepare(
        `SELECT pm.public_slug, c.action_checklist_json, c.source_recording_ids_json, c.language_framework, c.error_signature
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
          AND rrr.result_hash = e.rerun_result_hash`,
      )
      .all(query.languageFramework, query.errorSignature, query.errorSignature) as Array<{
      public_slug: string;
      action_checklist_json: string;
      source_recording_ids_json: string;
      language_framework: string;
      error_signature: string;
    }>;
    return rows.flatMap((row) => {
      if (!isPublicSlug(row.public_slug)) return [];
      const actionChecklist = parsePublicStringArray(row.action_checklist_json);
      const sourceRecordingIds = parsePublicStringArray(row.source_recording_ids_json);
      if (!actionChecklist || !sourceRecordingIds) return [];
      const languageFramework = redactPublicText(row.language_framework);
      const errorSignature = redactPublicText(row.error_signature);
      const dto = {
        publicRecordingLink: row.public_slug,
        actionChecklist: actionChecklist.map(redactPublicText),
        sourceRecordingIds,
        applicabilityExplanation: `Matched ${languageFramework} case for ${errorSignature}.`,
      };
      const safe = safePublicDto(dto, `sqlite-memory:${row.public_slug}`);
      return safe ? [safe] : [];
    });
  } finally {
    db.close();
  }
}
