import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, describe, it } from "node:test";
import {
  approveRecording,
  createAgentOjServer,
  createLeaderboardEntry,
  createPatchSubmission,
  createRunBundle,
  createSolutionRecording,
  openAgentOjDatabase,
  persistRunBundleToSqlite,
  promoteToPublicMemory,
  runAutomaticCheck,
  seedPermissiveCatalog,
  simulateSandboxVerification,
  type AgentOjApiConfig,
} from "../src/index.ts";
import { runCli } from "../src/cli.ts";


const servers: Server[] = [];

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "agentoj-api-read-"));
}
const PRIVATE_ORACLE_HASH = `sha256:${"a".repeat(64)}`;

function seedPrivateScoredCatalog() {
  const catalog = seedPermissiveCatalog();
  return {
    ...catalog,
    hostedProblem: {
      ...catalog.hostedProblem,
      scoringMode: "scored-hidden" as const,
      oracleMetadata: {
        kind: "generated-private" as const,
        hiddenRequired: true as const,
        oracleDescriptorHash: PRIVATE_ORACLE_HASH,
        originalEvidenceId: "private-original-evidence",
        rerunEvidenceId: "private-rerun-evidence",
      },
    },
  };
}

function scoredVerification(submission: ReturnType<typeof createPatchSubmission>, adapter: ReturnType<typeof seedPermissiveCatalog>["adapter"], scenario: Parameters<typeof simulateSandboxVerification>[2], runSeed: string) {
  const verification = simulateSandboxVerification(submission, adapter, scenario, runSeed);
  return {
    ...verification,
    job: {
      ...verification.job,
      scoringStatus: "scored" as const,
      sandboxMode: "docker" as const,
      oracleDescriptorHash: PRIVATE_ORACLE_HASH,
    },
  };
}


function seedRunDb(): { dbPath: string; recordingId: string; publicMemoryLink: string; runnerRuntimeMs: number } {
  const dir = tempDir();
  const dbPath = join(dir, "agentoj.sqlite");
  const catalog = seedPrivateScoredCatalog();
  const submission = createPatchSubmission(catalog.hostedProblem);
  const verification = scoredVerification(submission, catalog.adapter, "pass", "original");
  const rerun = scoredVerification(submission, catalog.adapter, "pass", "rerun");
  const recording = createSolutionRecording(catalog, submission, verification);
  const evidence = runAutomaticCheck(recording, rerun);
  const review = approveRecording(recording);
  const publicMemory = promoteToPublicMemory(recording, evidence, review);
  const leaderboard = createLeaderboardEntry(submission, verification);
  persistRunBundleToSqlite(
    dbPath,
    {
      ...createRunBundle({
        benchmark: catalog.benchmark,
        adapter: catalog.adapter,
        problem: catalog.hostedProblem,
        submission,
        runnerJob: verification.job,
        runnerResult: verification.result,
        recording,
        evidence,
        review,
        publicMemory,
        leaderboard,
      }),
      rerunRunnerJob: rerun.job,
      rerunRunnerResult: rerun.result,
    },
  );
  return { dbPath, recordingId: recording.id, publicMemoryLink: publicMemory.publicSlug, runnerRuntimeMs: verification.result.runtimeMs };
}

async function withServer(dbPath: string) {
  const config: AgentOjApiConfig = {
    dbPath,
    host: "127.0.0.1",
    port: 0,
    allowedOrigins: ["*"],
    localUserId: "local-user",
    adminToken: "secret-admin-token",
    runnerMode: "local",
  };
  const server = createAgentOjServer(config);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, config.host, resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  return { baseUrl: `http://${config.host}:${address.port}` };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    ),
  );
});

describe("AgentOJ API read surfaces", () => {
  it("serves leaderboard, public recordings, recording export, and memory search from approved public memory", async () => {
    const { dbPath, recordingId, publicMemoryLink, runnerRuntimeMs } = seedRunDb();
    const { baseUrl } = await withServer(dbPath);

    const problems = (await (await fetch(`${baseUrl}/api/problems`)).json()) as {
      problems: Array<{ id: string; hostingMode: string }>;
    };
    assert.equal(problems.problems.some((problem) => problem.id === "humaneval-001"), true);
    assert.equal(problems.problems.some((problem) => problem.hostingMode === "adapter-only"), true);

    const problem = (await (await fetch(`${baseUrl}/api/problems/humaneval-001`)).json()) as {
      problem: { id: string; upstreamTaskId: string };
    };
    assert.equal(problem.problem.id, "humaneval-001");
    assert.equal(problem.problem.upstreamTaskId, "HumanEval/1");

    const registry = (await (await fetch(`${baseUrl}/api/registry`)).json()) as {
      registry: Array<{ benchmarkId: string; legalStatus: string; redistributionRights: string }>;
    };
    assert.equal(registry.registry.some((entry) => entry.benchmarkId === "humaneval" && entry.legalStatus === "approved"), true);
    assert.equal(registry.registry.some((entry) => entry.benchmarkId === "mbpp" && entry.redistributionRights === "clear"), true);

    const leaderboard = (await (await fetch(`${baseUrl}/api/leaderboard`)).json()) as {
      leaderboard: Array<{ problemId: string; passFail: string; locAdded: number; runtimeMs: number }>;
    };
    assert.equal(leaderboard.leaderboard[0]?.problemId, "humaneval-001");
    assert.equal(leaderboard.leaderboard[0]?.passFail, "pass");
    assert.equal(leaderboard.leaderboard[0]?.locAdded, 8);
    assert.equal(leaderboard.leaderboard[0]?.runtimeMs, runnerRuntimeMs);

    const recordings = (await (await fetch(`${baseUrl}/api/recordings`)).json()) as {
      recordings: Array<{ id: string; publicSlug: string; summary: string }>;
    };
    assert.equal(recordings.recordings[0]?.id, recordingId);
    assert.equal(recordings.recordings[0]?.publicSlug, publicMemoryLink);
    assert.match(recordings.recordings[0]?.summary ?? "", /Fixed/);

    const recording = (await (await fetch(`${baseUrl}/api/recordings/${recordingId}`)).json()) as {
      recording: { id: string; publicSlug: string };
    };
    assert.equal(recording.recording.id, recordingId);
    assert.equal(recording.recording.publicSlug, publicMemoryLink);
    assert.equal(Object.hasOwn(recording.recording, "rawChainOfThought"), false);

    const exported = (await (await fetch(`${baseUrl}/api/recordings/${recordingId}/export`)).json()) as {
      markdown: string;
    };
    assert.match(exported.markdown, /# Solution Recording:/);
    assert.match(exported.markdown, /does not contain raw chain-of-thought/);
    assert.doesNotMatch(exported.markdown, /rawChainOfThought|hidden reasoning/i);

    const memory = (await (
      await fetch(`${baseUrl}/api/memory/search?errorSignature=target%20edge%20case&languageFramework=python`)
    ).json()) as { results: Array<{ publicRecordingLink: string; actionChecklist: string[] }> };
    assert.equal(memory.results[0]?.publicRecordingLink, publicMemoryLink);
    assert.equal(memory.results[0]?.actionChecklist.length, 2);
  });

  it("excludes unapproved recordings from public read endpoints and exported web data", async () => {
    const { dbPath, recordingId } = seedRunDb();
    const db = openAgentOjDatabase(dbPath);
    try {
      db.prepare("UPDATE review_gates SET trusted_reviewer_approval_status = 'pending' WHERE recording_id = ?").run(recordingId);
    } finally {
      db.close();
    }

    const { baseUrl } = await withServer(dbPath);
    const recordings = (await (await fetch(`${baseUrl}/api/recordings`)).json()) as { recordings: unknown[] };
    assert.equal(recordings.recordings.length, 0);

    const direct = await fetch(`${baseUrl}/api/recordings/${recordingId}`);
    assert.equal(direct.status, 404);

    const memory = (await (
      await fetch(`${baseUrl}/api/memory/search?errorSignature=target%20edge%20case&languageFramework=python`)
    ).json()) as { results: unknown[] };
    assert.equal(memory.results.length, 0);

    const outDir = join(tempDir(), "web-data");
    const exported = runCli(["export-web-data", "--db", dbPath, "--out", outDir]);
    assert.equal(exported.ok, true);
    const exportedRecordings = JSON.parse(readFileSync(join(outDir, "recordings.json"), "utf8")) as unknown[];
    const exportedMemory = JSON.parse(readFileSync(join(outDir, "memory.json"), "utf8")) as unknown[];
    assert.equal(exportedRecordings.length, 0);
    assert.equal(exportedMemory.length, 0);
  });
  it("excludes demo or non-distinct rerun evidence from public API and static exports", async () => {
    const cases = [
      {
        name: "demo recording",
        update: (db: ReturnType<typeof openAgentOjDatabase>) => {
          db.prepare("UPDATE solution_recordings SET scoring_status = 'demo'").run();
        },
      },
      {
        name: "rerun reuses original result",
        update: (db: ReturnType<typeof openAgentOjDatabase>) => {
          db.prepare(
            `UPDATE evidence_ledgers
             SET rerun_job_id = original_job_id,
                 rerun_result_id = original_result_id,
                 rerun_result_hash = original_result_hash`,
          ).run();
        },
      },
      {
        name: "missing oracle descriptor",
        update: (db: ReturnType<typeof openAgentOjDatabase>) => {
          db.prepare("UPDATE evidence_ledgers SET oracle_descriptor_hash = NULL").run();
        },
      },
    ];

    for (const entry of cases) {
      const { dbPath, recordingId } = seedRunDb();
      const db = openAgentOjDatabase(dbPath);
      try {
        entry.update(db);
      } finally {
        db.close();
      }

      const { baseUrl } = await withServer(dbPath);
      const leaderboard = (await (await fetch(`${baseUrl}/api/leaderboard`)).json()) as { leaderboard: unknown[] };
      assert.equal(leaderboard.leaderboard.length, 0, entry.name);

      const recordings = (await (await fetch(`${baseUrl}/api/recordings`)).json()) as { recordings: unknown[] };
      assert.equal(recordings.recordings.length, 0, entry.name);
      const direct = await fetch(`${baseUrl}/api/recordings/${recordingId}`);
      assert.equal(direct.status, 404, entry.name);

      const memory = (await (
        await fetch(`${baseUrl}/api/memory/search?errorSignature=target%20edge%20case&languageFramework=python`)
      ).json()) as { results: unknown[] };
      assert.equal(memory.results.length, 0, entry.name);

      const outDir = join(tempDir(), "web-data");
      const exported = runCli(["export-web-data", "--db", dbPath, "--out", outDir]);
      assert.equal(exported.ok, true, entry.name);
      assert.equal((JSON.parse(readFileSync(join(outDir, "leaderboard.json"), "utf8")) as unknown[]).length, 0, entry.name);
      assert.equal((JSON.parse(readFileSync(join(outDir, "recordings.json"), "utf8")) as unknown[]).length, 0, entry.name);
      assert.equal((JSON.parse(readFileSync(join(outDir, "memory.json"), "utf8")) as unknown[]).length, 0, entry.name);
    }
  });
  it("excludes recordings and memory when evidence or automatic review checks fail", async () => {
    const scenarios = [
      { table: "evidence_ledgers", column: "required_field_check", value: "fail" },
      { table: "evidence_ledgers", column: "patch_clean_apply_check", value: "fail" },
      { table: "evidence_ledgers", column: "verification_exit_zero_check", value: "fail" },
      { table: "evidence_ledgers", column: "sandbox_rerun_check", value: "fail" },
      { table: "review_gates", column: "automatic_check_status", value: "fail" },
    ];

    for (const scenario of scenarios) {
      const { dbPath, recordingId } = seedRunDb();
      const db = openAgentOjDatabase(dbPath);
      try {
        db.prepare(`UPDATE ${scenario.table} SET ${scenario.column} = ? WHERE recording_id = ?`).run(scenario.value, recordingId);
      } finally {
        db.close();
      }

      const { baseUrl } = await withServer(dbPath);
      const recordings = (await (await fetch(`${baseUrl}/api/recordings`)).json()) as { recordings: unknown[] };
      assert.equal(recordings.recordings.length, 0, `${scenario.table}.${scenario.column}`);

      const memory = (await (
        await fetch(`${baseUrl}/api/memory/search?errorSignature=target%20edge%20case&languageFramework=python`)
      ).json()) as { results: unknown[] };
      assert.equal(memory.results.length, 0, `${scenario.table}.${scenario.column}`);

      const outDir = join(tempDir(), "web-data");
      const exported = runCli(["export-web-data", "--db", dbPath, "--out", outDir]);
      assert.equal(exported.ok, true);
      assert.equal((JSON.parse(readFileSync(join(outDir, "recordings.json"), "utf8")) as unknown[]).length, 0);
      assert.equal((JSON.parse(readFileSync(join(outDir, "memory.json"), "utf8")) as unknown[]).length, 0);
    }
  });

  it("excludes ineligible leaderboard rows from public API and exported web data", async () => {
    const { dbPath } = seedRunDb();
    const db = openAgentOjDatabase(dbPath);
    try {
      db.prepare("UPDATE leaderboard_entries SET eligibility_status = 'ineligible', ineligibility_reason = 'failed run'").run();
    } finally {
      db.close();
    }

    const { baseUrl } = await withServer(dbPath);
    const leaderboard = (await (await fetch(`${baseUrl}/api/leaderboard`)).json()) as { leaderboard: unknown[] };
    assert.equal(leaderboard.leaderboard.length, 0);

    const outDir = join(tempDir(), "web-data");
    const exported = runCli(["export-web-data", "--db", dbPath, "--out", outDir]);
    assert.equal(exported.ok, true);
    const exportedLeaderboard = JSON.parse(readFileSync(join(outDir, "leaderboard.json"), "utf8")) as unknown[];
    assert.equal(exportedLeaderboard.length, 0);
  });
  it("excludes leaderboard rows whose public metrics do not match runner-derived metrics", async () => {
    const { dbPath } = seedRunDb();
    const db = openAgentOjDatabase(dbPath);
    try {
      db.prepare("UPDATE leaderboard_entries SET public_metrics_json = ?").run(
        JSON.stringify({ passFail: "pass", runtimeMs: 999999, filesChanged: 1, locAdded: 8, locDeleted: 1 }),
      );
    } finally {
      db.close();
    }

    const { baseUrl } = await withServer(dbPath);
    const leaderboard = (await (await fetch(`${baseUrl}/api/leaderboard`)).json()) as { leaderboard: unknown[] };
    assert.equal(leaderboard.leaderboard.length, 0);

    const outDir = join(tempDir(), "web-data");
    const exported = runCli(["export-web-data", "--db", dbPath, "--out", outDir]);
    assert.equal(exported.ok, true);
    const exportedLeaderboard = JSON.parse(readFileSync(join(outDir, "leaderboard.json"), "utf8")) as unknown[];
    assert.equal(exportedLeaderboard.length, 0);
  });
  it("excludes leaderboard rows with false reproducibility or falsified patch stats", async () => {
    const cases = [
      {
        name: "false reproducibility",
        update: (db: ReturnType<typeof openAgentOjDatabase>) => {
          db.prepare("UPDATE leaderboard_entries SET reproducible_result = 0").run();
        },
      },
      {
        name: "falsified loc",
        update: (db: ReturnType<typeof openAgentOjDatabase>) => {
          const runtime = db.prepare("SELECT runtime_ms FROM runner_results").get() as { runtime_ms: number };
          db.prepare("UPDATE leaderboard_entries SET public_metrics_json = ?").run(
            JSON.stringify({ passFail: "pass", runtimeMs: runtime.runtime_ms, filesChanged: 1, locAdded: 999, locDeleted: 2 }),
          );
        },
      },
    ];

    for (const entry of cases) {
      const { dbPath } = seedRunDb();
      const db = openAgentOjDatabase(dbPath);
      try {
        entry.update(db);
      } finally {
        db.close();
      }

      const { baseUrl } = await withServer(dbPath);
      const leaderboard = (await (await fetch(`${baseUrl}/api/leaderboard`)).json()) as { leaderboard: unknown[] };
      assert.equal(leaderboard.leaderboard.length, 0, entry.name);

      const outDir = join(tempDir(), "web-data");
      const exported = runCli(["export-web-data", "--db", dbPath, "--out", outDir]);
      assert.equal(exported.ok, true, entry.name);
      const exportedLeaderboard = JSON.parse(readFileSync(join(outDir, "leaderboard.json"), "utf8")) as unknown[];
      assert.equal(exportedLeaderboard.length, 0, entry.name);
    }
  });




  it("rejects corrupt leaderboard metrics instead of publishing fake defaults", async () => {
    const { dbPath } = seedRunDb();
    const db = openAgentOjDatabase(dbPath);
    try {
      db.prepare("UPDATE leaderboard_entries SET public_metrics_json = '{}'").run();
    } finally {
      db.close();
    }

    const { baseUrl } = await withServer(dbPath);
    const response = await fetch(`${baseUrl}/api/leaderboard`);
    const body = (await response.json()) as { code: string; error: string };

    assert.equal(response.status, 500);
    assert.equal(body.code, "internal_error");
    assert.equal(body.error, "Internal server error.");

    const outDir = join(tempDir(), "web-data");
    assert.throws(() => runCli(["export-web-data", "--db", dbPath, "--out", outDir]), /Invalid public metric: passFail/);
  });
  it("rejects non-positive public leaderboard metrics on API and export surfaces", async () => {
    const { dbPath } = seedRunDb();
    const db = openAgentOjDatabase(dbPath);
    try {
      db.prepare("UPDATE leaderboard_entries SET public_metrics_json = ?").run(
        JSON.stringify({ passFail: "pass", runtimeMs: 0, filesChanged: 1, locAdded: 8, locDeleted: 1 }),
      );
    } finally {
      db.close();
    }

    const { baseUrl } = await withServer(dbPath);
    const response = await fetch(`${baseUrl}/api/leaderboard`);
    assert.equal(response.status, 500);

    const outDir = join(tempDir(), "web-data");
    assert.throws(() => runCli(["export-web-data", "--db", dbPath, "--out", outDir]), /Invalid public metric: runtimeMs/);
  });
  it("rejects invalid pass/fail and negative public leaderboard metrics", async () => {
    const cases = [
      {
        metrics: { passFail: "unknown", runtimeMs: 1500, filesChanged: 1, locAdded: 8, locDeleted: 1 },
        message: /Invalid public metric: passFail/,
      },
      {
        metrics: { passFail: "pass", runtimeMs: 1500, filesChanged: 1, locAdded: -1, locDeleted: 1 },
        message: /Invalid public metric: locAdded/,
      },
    ];

    for (const entry of cases) {
      const { dbPath } = seedRunDb();
      const db = openAgentOjDatabase(dbPath);
      try {
        db.prepare("UPDATE leaderboard_entries SET public_metrics_json = ?").run(JSON.stringify(entry.metrics));
      } finally {
        db.close();
      }

      const { baseUrl } = await withServer(dbPath);
      const response = await fetch(`${baseUrl}/api/leaderboard`);
      assert.equal(response.status, 500);

      const outDir = join(tempDir(), "web-data");
      assert.throws(() => runCli(["export-web-data", "--db", dbPath, "--out", outDir]), entry.message);
    }
  });
  it("applies defense-in-depth DTO validation to API public read rows", async () => {
    const { dbPath } = seedRunDb();
    const db = openAgentOjDatabase(dbPath);
    try {
      db.prepare("UPDATE leaderboard_entries SET ineligibility_reason = ?").run("AGENTOJ_TRUSTED_PROXY_SECRET=supersecret");
      db.prepare("UPDATE public_memory_entries SET public_slug = ?").run("AGENTOJ_TRUSTED_PROXY_SECRET=supersecret");
      db.prepare("UPDATE checklist_cases SET source_recording_ids_json = ?").run("{not-json");
    } finally {
      db.close();
    }

    const { baseUrl } = await withServer(dbPath);
    const leaderboardResponse = await fetch(`${baseUrl}/api/leaderboard`);
    const leaderboardText = await leaderboardResponse.text();
    assert.equal(leaderboardResponse.status, 200);
    assert.equal(leaderboardText.includes("supersecret"), false);

    const recordings = JSON.parse(await (await fetch(`${baseUrl}/api/recordings`)).text()) as { recordings: unknown[] };
    assert.equal(recordings.recordings.length, 0);

    const memory = JSON.parse(
      await (await fetch(`${baseUrl}/api/memory/search?errorSignature=target%20edge%20case&languageFramework=python`)).text(),
    ) as { results: unknown[] };
    assert.equal(memory.results.length, 0);
    const cliMemory = runCli(["memory", "search", "--db", dbPath, "--error", "target edge case", "--framework", "python"]);
    assert.equal(cliMemory.ok, true);
    assert.equal(cliMemory.results?.length, 0);
  });

  it("escapes and redacts DB-derived evidence fields in public markdown export", () => {
    const { dbPath, recordingId } = seedRunDb();
    const db = openAgentOjDatabase(dbPath);
    try {
      db.prepare("UPDATE solution_recordings SET final_patch_sha256 = ? WHERE id = ?").run("[patch](javascript:alert(1))", recordingId);
      db.prepare("UPDATE evidence_ledgers SET evidence_hash = ? WHERE recording_id = ?").run(
        "evidence AGENTOJ_TRUSTED_PROXY_SECRET=supersecret",
        recordingId,
      );
    } finally {
      db.close();
    }

    const exported = runCli(["export-recording", recordingId, "--db", dbPath]);
    assert.equal(exported.ok, true);
    assert.equal(exported.markdown?.includes("supersecret"), false);
    assert.match(exported.markdown ?? "", /\\\[patch\\\]\\\(javascript:alert\\\(1\\\)\\\)/);
  });
  it("skips corrupt static export memory rows after allowlisted DTO redaction", () => {
    const { dbPath } = seedRunDb();
    const db = openAgentOjDatabase(dbPath);
    try {
      db.prepare("UPDATE checklist_cases SET action_checklist_json = ?").run("{not-json");
      db.prepare("UPDATE solution_recordings SET summary = ?").run(
        "safe summary AGENTOJ_TRUSTED_PROXY_SECRET=supersecret diff --git\n+ leaked_line",
      );
    } finally {
      db.close();
    }

    const outDir = join(tempDir(), "web-data");
    const exported = runCli(["export-web-data", "--db", dbPath, "--out", outDir]);
    assert.equal(exported.ok, true);
    const exportedMemory = JSON.parse(readFileSync(join(outDir, "memory.json"), "utf8")) as unknown[];
    const exportedRecordings = JSON.parse(readFileSync(join(outDir, "recordings.json"), "utf8")) as Array<{ summary: string }>;
    assert.equal(exportedMemory.length, 0);
    assert.equal(exportedRecordings[0]?.summary.includes("supersecret"), false);
    assert.equal(exportedRecordings[0]?.summary.includes("diff --git"), false);
  });

  it("keeps the BOJ-style Pages UI static-first while supporting configured API mode", () => {
    const app = readFileSync("web/app.js", "utf8");
    assert.match(app, /configuredApiBase/);
    assert.match(app, /agentojApiBase/);
    assert.match(app, /\/api\/health/);
    assert.match(app, /\/api\/problems/);
    assert.match(app, /\.\/data\/problems\.json/);
    assert.match(app, /source === "api" \? "API" : "JSON"/);
  });
});
