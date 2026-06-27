import type { Adapter, Benchmark, Problem } from "../contracts/types.ts";
import { validateAdapter, validateBenchmark, validateProblem } from "../contracts/validators.ts";

export const MBPP_BENCHMARK: Benchmark = {
  id: "mbpp",
  name: "Mostly Basic Python Problems",
  upstreamUrl: "https://github.com/google-research/google-research/tree/master/mbpp",
  upstreamCommitOrVersion: "adapter-seed-synthetic-2026-06-24",
  licenseId: "Apache-2.0",
  legalStatus: "approved",
  redistributionRights: "clear",
  defaultHostingMode: "adapter-only",
};

export const MBPP_ADAPTER: Adapter = {
  id: "mbpp-python",
  benchmarkId: MBPP_BENCHMARK.id,
  adapterVersion: "0.1.0",
  fetchStrategy: "upstream-checkout",
  judgeCommand: ["python3", "-m", "unittest", "discover", "-s", "tests"],
  verificationCommands: [["python3", "-m", "unittest", "discover", "-s", "tests"]],
  supportedHostingModes: ["adapter-only"],
  dockerImageDigest: "python:3.12.11-slim-bookworm@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7",
  defaultResources: {
    timeoutSeconds: 60,
    cpuCores: 1,
    memoryMb: 512,
    networkPolicy: "blocked",
  },
};

export const MBPP_PROBLEMS: Problem[] = [
  {
    id: "mbpp-001-adapter-only",
    benchmarkId: MBPP_BENCHMARK.id,
    adapterId: MBPP_ADAPTER.id,
    upstreamTaskId: "MBPP/adapter-seed-001",
    title: "Reverse a string",
    languageFrameworkTags: ["python", "unittest", "string"],
    hostingMode: "adapter-only",
    enabled: true,
    editableFilePaths: ["solution.py"],
  },
  {
    id: "mbpp-002-adapter-only",
    benchmarkId: MBPP_BENCHMARK.id,
    adapterId: MBPP_ADAPTER.id,
    upstreamTaskId: "MBPP/adapter-seed-002",
    title: "Count vowels",
    languageFrameworkTags: ["python", "unittest", "string"],
    hostingMode: "adapter-only",
    enabled: true,
    editableFilePaths: ["solution.py"],
  },
  {
    id: "mbpp-003-adapter-only",
    benchmarkId: MBPP_BENCHMARK.id,
    adapterId: MBPP_ADAPTER.id,
    upstreamTaskId: "MBPP/adapter-seed-003",
    title: "Sum unique integers",
    languageFrameworkTags: ["python", "unittest", "set", "list"],
    hostingMode: "adapter-only",
    enabled: true,
    editableFilePaths: ["solution.py"],
  },
];

export function listMbppProblems(): readonly Problem[] {
  return MBPP_PROBLEMS;
}

export function getMbppProblem(problemId: string): Problem | undefined {
  return MBPP_PROBLEMS.find((problem) => problem.id === problemId);
}

export function validateMbppAdapterSeed(): void {
  const benchmark = validateBenchmark(MBPP_BENCHMARK);
  if (!benchmark.ok) throw new Error(`Invalid MBPP benchmark: ${benchmark.issues.map((issue) => issue.code).join(",")}`);

  const adapter = validateAdapter(MBPP_ADAPTER, MBPP_BENCHMARK);
  if (!adapter.ok) throw new Error(`Invalid MBPP adapter: ${adapter.issues.map((issue) => issue.code).join(",")}`);

  for (const problem of MBPP_PROBLEMS) {
    const result = validateProblem(problem, MBPP_BENCHMARK, MBPP_ADAPTER);
    if (!result.ok) throw new Error(`Invalid MBPP problem ${problem.id}: ${result.issues.map((issue) => issue.code).join(",")}`);
  }
}
