import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Adapter,
  Benchmark,
  EvidenceLedger,
  LeaderboardEntry,
  PatchSubmission,
  Problem,
  PublicMemoryEntry,
  ReviewGate,
  RunnerJob,
  RunnerResult,
  SolutionRecording,
} from "../contracts/types.ts";

export interface RunBundle {
  schemaVersion: 1;
  recordedAt: string;
  benchmark: Benchmark;
  adapter: Adapter;
  problem: Problem;
  submission: PatchSubmission;
  runnerJob: RunnerJob;
  runnerResult: RunnerResult;
  recording: SolutionRecording;
  evidence: EvidenceLedger;
  review: ReviewGate;
  publicMemory: PublicMemoryEntry;
  leaderboard: LeaderboardEntry;
}

export interface PersistedRunBundle {
  bundle: RunBundle;
  path: string;
  lineNumber: number;
}

export function createRunBundle(input: Omit<RunBundle, "schemaVersion" | "recordedAt">, recordedAt = new Date().toISOString()): RunBundle {
  return {
    schemaVersion: 1,
    recordedAt,
    ...input,
  };
}

export function appendRunBundle(outDir: string, bundle: RunBundle): PersistedRunBundle {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, "runs.jsonl");
  let lineNumber = 1;
  try {
    const existing = readFileSync(path, "utf8");
    lineNumber = existing.trim().length === 0 ? 1 : existing.trimEnd().split("\n").length + 1;
  } catch {
    lineNumber = 1;
  }
  appendFileSync(path, `${JSON.stringify(bundle)}\n`, "utf8");
  return { bundle, path, lineNumber };
}

export function readRunBundles(path: string): RunBundle[] {
  const content = readFileSync(path, "utf8").trim();
  if (content.length === 0) return [];
  return content.split("\n").map((line) => JSON.parse(line) as RunBundle);
}
