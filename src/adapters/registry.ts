import type { Adapter, Benchmark, Problem } from "../contracts/types.ts";
import { HUMANEVAL_ADAPTER, HUMANEVAL_BENCHMARK, HUMANEVAL_PROBLEMS, validateHumanEvalAdapterSeed } from "./humaneval.ts";
import { MBPP_ADAPTER, MBPP_BENCHMARK, MBPP_PROBLEMS, validateMbppAdapterSeed } from "./mbpp.ts";
import { QUIXBUGS_ADAPTER, QUIXBUGS_BENCHMARK, QUIXBUGS_PROBLEMS, validateQuixBugsAdapterSeed } from "./quixbugs.ts";
import { SWEBENCH_LITE_ADAPTER, SWEBENCH_LITE_BENCHMARK, SWEBENCH_LITE_PROBLEMS, validateSwebenchLiteAdapterSeed } from "./swebench-lite.ts";
import { SWEBENCH_VERIFIED_ADAPTER, SWEBENCH_VERIFIED_BENCHMARK, SWEBENCH_VERIFIED_PROBLEMS, validateSwebenchVerifiedAdapterSeed } from "./swebench-verified.ts";

export interface AdapterRegistryEntry {
  benchmark: Benchmark;
  adapter?: Adapter;
  status: "implemented" | "candidate";
  dataPolicy: "metadata-only" | "fixture-seed" | "full-hidden-plus-fixture-seed";
  notes: string;
}

export const ADAPTER_REGISTRY: readonly AdapterRegistryEntry[] = [
  {
    benchmark: HUMANEVAL_BENCHMARK,
    adapter: HUMANEVAL_ADAPTER,
    status: "implemented",
    dataPolicy: "full-hidden-plus-fixture-seed",
    notes: "Full HumanEval scored-hidden public catalog with descriptor hashes plus local demo fixtures; private oracle descriptors are loaded from secrets/artifacts.",
  },
  {
    benchmark: MBPP_BENCHMARK,
    adapter: MBPP_ADAPTER,
    status: "implemented",
    dataPolicy: "full-hidden-plus-fixture-seed",
    notes: "MBPP subset-50-v1 scored-hidden public catalog with descriptor hashes plus adapter-only demo fixtures; private oracle descriptors are loaded from secrets/artifacts.",
  },
  {
    benchmark: QUIXBUGS_BENCHMARK,
    adapter: QUIXBUGS_ADAPTER,
    status: "implemented",
    dataPolicy: "full-hidden-plus-fixture-seed",
    notes: "QuixBugs Python subset-10-v1 scored-hidden public catalog with command-hidden descriptor hashes plus a pinned upstream bitcount fixture seed; private command descriptors and hidden test bundles are loaded from secrets/artifacts.",
  },
  {
    benchmark: SWEBENCH_LITE_BENCHMARK,
    adapter: SWEBENCH_LITE_ADAPTER,
    status: "implemented",
    dataPolicy: "full-hidden-plus-fixture-seed",
    notes: "SWE-bench Lite official-harness scored surface with one maintainer-triggered allowlisted instance; private swebench-upstream-harness descriptors are loaded from secrets/artifacts.",
  },
  {
    benchmark: SWEBENCH_VERIFIED_BENCHMARK,
    adapter: SWEBENCH_VERIFIED_ADAPTER,
    status: "implemented",
    dataPolicy: "full-hidden-plus-fixture-seed",
    notes: "SWE-bench Verified official-harness scored surface with one maintainer-triggered allowlisted instance; private swebench-upstream-harness descriptors are loaded from secrets/artifacts and Lite evidence cannot satisfy Verified scoring.",
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
    ...QUIXBUGS_PROBLEMS.map((problem) => ({
      benchmark: QUIXBUGS_BENCHMARK,
      adapter: QUIXBUGS_ADAPTER,
      problem,
    })),
    ...SWEBENCH_LITE_PROBLEMS.map((problem) => ({
      benchmark: SWEBENCH_LITE_BENCHMARK,
      adapter: SWEBENCH_LITE_ADAPTER,
      problem,
    })),
    ...SWEBENCH_VERIFIED_PROBLEMS.map((problem) => ({
      benchmark: SWEBENCH_VERIFIED_BENCHMARK,
      adapter: SWEBENCH_VERIFIED_ADAPTER,
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
  validateQuixBugsAdapterSeed();
  validateSwebenchLiteAdapterSeed();
  validateSwebenchVerifiedAdapterSeed();
}
