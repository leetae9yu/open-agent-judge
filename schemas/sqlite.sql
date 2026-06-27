PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS benchmarks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  upstream_url TEXT NOT NULL,
  upstream_commit_or_version TEXT NOT NULL,
  license_id TEXT NOT NULL CHECK (license_id IN ('MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause')),
  legal_status TEXT NOT NULL CHECK (legal_status IN ('approved', 'unknown', 'rejected')),
  redistribution_rights TEXT NOT NULL CHECK (redistribution_rights IN ('clear', 'unclear', 'forbidden')),
  default_hosting_mode TEXT NOT NULL CHECK (default_hosting_mode IN ('hosted', 'adapter-only'))
);

CREATE TABLE IF NOT EXISTS adapters (
  id TEXT PRIMARY KEY,
  benchmark_id TEXT NOT NULL REFERENCES benchmarks(id),
  adapter_version TEXT NOT NULL,
  fetch_strategy TEXT NOT NULL CHECK (fetch_strategy IN ('upstream-checkout', 'hosted-fixture')),
  judge_command_json TEXT NOT NULL,
  verification_commands_json TEXT NOT NULL,
  supported_hosting_modes_json TEXT NOT NULL,
  docker_image_digest TEXT NOT NULL,
  resources_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS problems (
  id TEXT PRIMARY KEY,
  benchmark_id TEXT NOT NULL REFERENCES benchmarks(id),
  adapter_id TEXT NOT NULL REFERENCES adapters(id),
  upstream_task_id TEXT NOT NULL,
  title TEXT NOT NULL,
  language_framework_tags_json TEXT NOT NULL,
  hosting_mode TEXT NOT NULL CHECK (hosting_mode IN ('hosted', 'adapter-only')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  UNIQUE (benchmark_id, upstream_task_id)
);

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  patch_sha256 TEXT NOT NULL,
  patch_stats_json TEXT NOT NULL,
  supplied_metrics_json TEXT,
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'public-summary', 'public-full')),
  public_metrics_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS submission_patches (
  submission_id TEXT PRIMARY KEY REFERENCES submissions(id),
  patch_text TEXT NOT NULL
);


CREATE TABLE IF NOT EXISTS runner_jobs (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  adapter_id TEXT NOT NULL REFERENCES adapters(id),
  upstream_commit TEXT NOT NULL,
  docker_image_digest TEXT NOT NULL,
  resources_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'passed', 'failed', 'timed-out', 'infra-error')),
  scoring_status TEXT NOT NULL DEFAULT 'demo' CHECK (scoring_status IN ('demo', 'scored')),
  sandbox_mode TEXT NOT NULL DEFAULT 'local' CHECK (sandbox_mode IN ('local', 'docker')),
  oracle_descriptor_hash TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_runner_jobs_status ON runner_jobs(status, created_at);

CREATE TABLE IF NOT EXISTS runner_results (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES runner_jobs(id),
  patch_apply_status TEXT NOT NULL CHECK (patch_apply_status IN ('clean', 'dirty', 'failed')),
  exit_code INTEGER NOT NULL,
  pass_fail TEXT NOT NULL CHECK (pass_fail IN ('pass', 'fail')),
  runtime_ms INTEGER NOT NULL,
  memory_peak_mb INTEGER,
  stdout_ref TEXT NOT NULL,
  stderr_ref TEXT NOT NULL,
  result_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS solution_recordings (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL UNIQUE REFERENCES submissions(id),
  problem_id TEXT NOT NULL REFERENCES problems(id),
  benchmark_id TEXT NOT NULL REFERENCES benchmarks(id),
  upstream_commit TEXT NOT NULL,
  docker_image_digest TEXT NOT NULL,
  resources_json TEXT NOT NULL,
  final_patch_sha256 TEXT NOT NULL,
  pass_fail TEXT NOT NULL CHECK (pass_fail = 'pass'),
  loc_delta_json TEXT NOT NULL,
  token_metrics_json TEXT,
  summary TEXT NOT NULL,
  root_cause TEXT NOT NULL,
  fix_description TEXT NOT NULL,
  verification_commands_json TEXT NOT NULL,
  evidence_ledger_id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL,
  immutable INTEGER NOT NULL CHECK (immutable = 1),
  scoring_status TEXT NOT NULL DEFAULT 'demo' CHECK (scoring_status IN ('demo', 'scored')),
  original_job_id TEXT,
  original_result_id TEXT,
  original_result_hash TEXT,
  oracle_descriptor_hash TEXT
);

CREATE TABLE IF NOT EXISTS evidence_ledgers (
  id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL UNIQUE REFERENCES solution_recordings(id),
  required_field_check TEXT NOT NULL CHECK (required_field_check IN ('pass', 'fail')),
  patch_clean_apply_check TEXT NOT NULL CHECK (patch_clean_apply_check IN ('pass', 'fail')),
  verification_exit_zero_check TEXT NOT NULL CHECK (verification_exit_zero_check IN ('pass', 'fail')),
  sandbox_rerun_check TEXT NOT NULL CHECK (sandbox_rerun_check IN ('pass', 'fail')),
  rerun_job_id TEXT NOT NULL REFERENCES runner_jobs(id),
  original_job_id TEXT,
  original_result_id TEXT,
  original_result_hash TEXT,
  rerun_result_id TEXT,
  rerun_result_hash TEXT,
  oracle_descriptor_hash TEXT,
  checker_version TEXT NOT NULL,
  evidence_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS failed_run_attempts (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL UNIQUE REFERENCES submissions(id),
  problem_id TEXT NOT NULL REFERENCES problems(id),
  runner_job_id TEXT NOT NULL REFERENCES runner_jobs(id),
  runner_result_id TEXT NOT NULL REFERENCES runner_results(id),
  error TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS review_gates (
  id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL UNIQUE REFERENCES solution_recordings(id),
  automatic_check_status TEXT NOT NULL CHECK (automatic_check_status IN ('pass', 'fail')),
  trusted_reviewer_approval_status TEXT NOT NULL CHECK (trusted_reviewer_approval_status IN ('pending', 'approved', 'rejected')),
  reviewer_id TEXT,
  reviewer_notes TEXT
);

CREATE TABLE IF NOT EXISTS public_memory_entries (
  id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL UNIQUE REFERENCES solution_recordings(id),
  public_slug TEXT NOT NULL UNIQUE,
  source_checklist_case_ids_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checklist_cases (
  id TEXT PRIMARY KEY,
  public_memory_entry_id TEXT NOT NULL REFERENCES public_memory_entries(id),
  recording_id TEXT NOT NULL REFERENCES solution_recordings(id),
  language_framework TEXT NOT NULL,
  error_signature TEXT NOT NULL,
  action_checklist_json TEXT NOT NULL,
  source_recording_ids_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leaderboard_entries (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL UNIQUE REFERENCES submissions(id),
  problem_id TEXT NOT NULL REFERENCES problems(id),
  reproducible_result INTEGER NOT NULL CHECK (reproducible_result IN (0, 1)),
  public_metrics_json TEXT NOT NULL,
  eligibility_status TEXT NOT NULL CHECK (eligibility_status IN ('eligible', 'ineligible')),
  ineligibility_reason TEXT
);

CREATE TABLE IF NOT EXISTS discussion_posts (
  id TEXT PRIMARY KEY,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  author_id TEXT NOT NULL,
  markdown TEXT NOT NULL,
  moderation_state TEXT NOT NULL CHECK (moderation_state IN ('visible', 'hidden', 'flagged')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tag_suggestions (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('problem', 'recording')),
  tag TEXT NOT NULL,
  suggested_by TEXT NOT NULL,
  reviewer_decision TEXT NOT NULL CHECK (reviewer_decision IN ('pending', 'approved', 'rejected')),
  reviewer_id TEXT,
  reviewer_notes TEXT
);

CREATE TABLE IF NOT EXISTS difficulty_votes (
  id TEXT PRIMARY KEY,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  voter_id TEXT NOT NULL,
  value INTEGER NOT NULL CHECK (value BETWEEN 1 AND 5),
  UNIQUE (problem_id, voter_id)
);

CREATE TABLE IF NOT EXISTS approved_difficulties (
  problem_id TEXT PRIMARY KEY REFERENCES problems(id),
  approved_value INTEGER NOT NULL CHECK (approved_value BETWEEN 1 AND 5),
  reviewer_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_problems_benchmark ON problems(benchmark_id);
CREATE INDEX IF NOT EXISTS idx_submissions_problem ON submissions(problem_id);
CREATE INDEX IF NOT EXISTS idx_recordings_problem ON solution_recordings(problem_id);
CREATE INDEX IF NOT EXISTS idx_checklist_lookup ON checklist_cases(language_framework, error_signature);
CREATE INDEX IF NOT EXISTS idx_leaderboard_problem ON leaderboard_entries(problem_id, eligibility_status);
