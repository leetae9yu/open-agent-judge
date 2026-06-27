import type { Adapter, Benchmark, Problem } from "../contracts/types.ts";
import { validateAdapter, validateBenchmark, validateProblem } from "../contracts/validators.ts";
import { HUMANEVAL_FULL_DESCRIPTOR_REVISION, HUMANEVAL_FULL_ORACLE_MANIFEST, HUMANEVAL_UPSTREAM_COMMIT, HUMANEVAL_UPSTREAM_DATA_SHA256, HUMANEVAL_UPSTREAM_DATA_URL, humanEvalFullScoredProblems } from "./humaneval-full.ts";

export const HUMANEVAL_BENCHMARK: Benchmark = {
  id: "humaneval",
  name: "HumanEval",
  upstreamUrl: "https://github.com/openai/human-eval",
  upstreamCommitOrVersion: HUMANEVAL_UPSTREAM_COMMIT,
  licenseId: "MIT",
  legalStatus: "approved",
  redistributionRights: "clear",
  defaultHostingMode: "hosted",
};

export const HUMANEVAL_ADAPTER: Adapter = {
  id: "humaneval-python",
  benchmarkId: HUMANEVAL_BENCHMARK.id,
  adapterVersion: "0.1.0",
  fetchStrategy: "upstream-checkout",
  judgeCommand: ["python3", "-m", "unittest", "discover", "-s", "tests"],
  verificationCommands: [["python3", "-m", "unittest", "discover", "-s", "tests"]],
  supportedHostingModes: ["hosted", "adapter-only"],
  dockerImageDigest: "python:3.12.11-slim-bookworm@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7",
  defaultResources: {
    timeoutSeconds: 60,
    cpuCores: 1,
    memoryMb: 512,
    networkPolicy: "blocked",
  },
};

export const HUMANEVAL_DEMO_PROBLEMS: Problem[] = [
  {
    id: "humaneval-001",
    benchmarkId: HUMANEVAL_BENCHMARK.id,
    adapterId: HUMANEVAL_ADAPTER.id,
    upstreamTaskId: "HumanEval/1",
    title: "Return the first element",
    languageFrameworkTags: ["python", "unittest", "list"],
    hostingMode: "hosted",
    enabled: true,
    editableFilePaths: ["solution.py"],
  },
  {
    id: "humaneval-002",
    benchmarkId: HUMANEVAL_BENCHMARK.id,
    adapterId: HUMANEVAL_ADAPTER.id,
    upstreamTaskId: "HumanEval/2",
    title: "Return the largest element",
    languageFrameworkTags: ["python", "unittest", "list"],
    hostingMode: "hosted",
    enabled: true,
    editableFilePaths: ["solution.py"],
  },
  {
    id: "humaneval-003-adapter-only",
    benchmarkId: HUMANEVAL_BENCHMARK.id,
    adapterId: HUMANEVAL_ADAPTER.id,
    upstreamTaskId: "HumanEval/3",
    title: "Reverse a string",
    languageFrameworkTags: ["python", "unittest", "string"],
    hostingMode: "adapter-only",
    enabled: true,
    editableFilePaths: ["solution.py"],
  },
];

export const HUMANEVAL_SCORED_PROBLEMS: Problem[] = humanEvalFullScoredProblems(HUMANEVAL_BENCHMARK.id, HUMANEVAL_ADAPTER.id);

export const HUMANEVAL_PROBLEMS: Problem[] = [...HUMANEVAL_DEMO_PROBLEMS, ...HUMANEVAL_SCORED_PROBLEMS];

export const HUMANEVAL_DESCRIPTOR_HASH_MANIFEST = HUMANEVAL_FULL_ORACLE_MANIFEST;
export { HUMANEVAL_FULL_DESCRIPTOR_REVISION, HUMANEVAL_UPSTREAM_DATA_SHA256, HUMANEVAL_UPSTREAM_DATA_URL };

export function listHumanEvalProblems(): readonly Problem[] {
  return HUMANEVAL_PROBLEMS;
}

export function getHumanEvalProblem(problemId: string): Problem | undefined {
  return HUMANEVAL_PROBLEMS.find((problem) => problem.id === problemId);
}

export function validateHumanEvalAdapterSeed(): void {
  const benchmark = validateBenchmark(HUMANEVAL_BENCHMARK);
  if (!benchmark.ok) throw new Error(`Invalid HumanEval benchmark: ${benchmark.issues.map((issue) => issue.code).join(",")}`);

  const adapter = validateAdapter(HUMANEVAL_ADAPTER, HUMANEVAL_BENCHMARK);
  if (!adapter.ok) throw new Error(`Invalid HumanEval adapter: ${adapter.issues.map((issue) => issue.code).join(",")}`);

  for (const problem of HUMANEVAL_PROBLEMS) {
    const result = validateProblem(problem, HUMANEVAL_BENCHMARK, HUMANEVAL_ADAPTER);
    if (!result.ok) throw new Error(`Invalid HumanEval problem ${problem.id}: ${result.issues.map((issue) => issue.code).join(",")}`);
  }
}
