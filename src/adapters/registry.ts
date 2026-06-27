import type { Adapter, Benchmark, Problem } from "../contracts/types.ts";
import { HUMANEVAL_ADAPTER, HUMANEVAL_BENCHMARK, HUMANEVAL_PROBLEMS, validateHumanEvalAdapterSeed } from "./humaneval.ts";
import { MBPP_ADAPTER, MBPP_BENCHMARK, MBPP_PROBLEMS, validateMbppAdapterSeed } from "./mbpp.ts";

export interface AdapterRegistryEntry {
  benchmark: Benchmark;
  adapter?: Adapter;
  status: "implemented" | "candidate";
  dataPolicy: "metadata-only" | "fixture-seed";
  notes: string;
}

export const ADAPTER_REGISTRY: readonly AdapterRegistryEntry[] = [
  {
    benchmark: HUMANEVAL_BENCHMARK,
    adapter: HUMANEVAL_ADAPTER,
    status: "implemented",
    dataPolicy: "fixture-seed",
    notes: "Initial runnable Python fixture seed; upstream data is not vendored.",
  },
  {
    benchmark: MBPP_BENCHMARK,
    adapter: MBPP_ADAPTER,
    status: "implemented",
    dataPolicy: "fixture-seed",
    notes: "Adapter-only synthetic fixture seed for the MBPP contract; upstream task data is not vendored.",
  },
  {
    benchmark: {
      id: "quixbugs",
      name: "QuixBugs",
      upstreamUrl: "https://github.com/jkoppel/QuixBugs",
      upstreamCommitOrVersion: "metadata-only",
      licenseId: "MIT",
      legalStatus: "approved",
      redistributionRights: "clear",
      defaultHostingMode: "adapter-only",
    },
    status: "candidate",
    dataPolicy: "metadata-only",
    notes: "Candidate bug-fix adapter for small algorithmic bugs; metadata only.",
  },
  {
    benchmark: {
      id: "swe-bench-lite",
      name: "SWE-bench Lite",
      upstreamUrl: "https://github.com/SWE-bench/SWE-bench",
      upstreamCommitOrVersion: "metadata-only",
      licenseId: "MIT",
      legalStatus: "approved",
      redistributionRights: "clear",
      defaultHostingMode: "adapter-only",
    },
    status: "candidate",
    dataPolicy: "metadata-only",
    notes: "Candidate repo-level benchmark adapter; use upstream checkout references, not vendored instances.",
  },
];

export function listAdapterRegistry(): readonly AdapterRegistryEntry[] {
  return ADAPTER_REGISTRY;
}

export function getAdapterRegistryEntry(benchmarkId: string): AdapterRegistryEntry | undefined {
  return ADAPTER_REGISTRY.find((entry) => entry.benchmark.id === benchmarkId);
}

export interface ImplementedProblemCatalog {
  benchmark: Benchmark;
  adapter: Adapter;
  problem: Problem;
}

export function listImplementedProblemCatalogs(): ImplementedProblemCatalog[] {
  return [
    ...HUMANEVAL_PROBLEMS.map((problem) => ({
      benchmark: HUMANEVAL_BENCHMARK,
      adapter: HUMANEVAL_ADAPTER,
      problem,
    })),
    ...MBPP_PROBLEMS.map((problem) => ({
      benchmark: MBPP_BENCHMARK,
      adapter: MBPP_ADAPTER,
      problem,
    })),
  ];
}

export function listImplementedProblems(): Problem[] {
  return listImplementedProblemCatalogs().map((entry) => entry.problem);
}

export function getImplementedProblemCatalog(problemId: string): ImplementedProblemCatalog | undefined {
  return listImplementedProblemCatalogs().find((entry) => entry.problem.id === problemId);
}

export function validateImplementedAdapterSeeds(): void {
  validateHumanEvalAdapterSeed();
  validateMbppAdapterSeed();
}
