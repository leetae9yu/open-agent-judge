import type { Adapter, Benchmark, Problem } from "../contracts/types.ts";
import { validateAdapter, validateBenchmark, validateProblem } from "../contracts/validators.ts";

export const SWEBENCH_LITE_DATASET_NAME = "princeton-nlp/SWE-bench_Lite";
export const SWEBENCH_LITE_DATASET_REVISION = "6ec7bb89b9342f664a54a6e0a6ea6501d3437cc2";
export const SWEBENCH_LITE_HARNESS_COMMIT = "f7bbbb2ccdf479001d6467c9e34af59e44a840f9";
export const SWEBENCH_LITE_HARNESS_IMAGE_DIGEST =
  "swebench/sweb.eval.x86_64.astropy_1776_astropy-12907@sha256:f3f63bb87d581c0e7b47f900dd82165b71040e1758d3c29e915e2b18da9baf63";
export const SWEBENCH_LITE_DESCRIPTOR_REVISION = "swe-bench-lite-official-1-v1";
export const SWEBENCH_LITE_PREDICTION_JSONL_SCHEMA_HASH = "sha256:1f4f2da592ab5373104554cc3c55408feb0209c9fd32ff3bc603e81ad4933236";

export interface SwebenchLiteManifestEntry {
  problemId: string;
  upstreamTaskId: string;
  instanceId: string;
  repo: string;
  baseCommit: string;
  title: string;
  oracleDescriptorHash: string;
}

export const SWEBENCH_LITE_BENCHMARK: Benchmark = {
  id: "swe-bench-lite",
  name: "SWE-bench Lite",
  upstreamUrl: "https://github.com/SWE-bench/SWE-bench",
  upstreamCommitOrVersion: SWEBENCH_LITE_HARNESS_COMMIT,
  licenseId: "MIT",
  legalStatus: "approved",
  redistributionRights: "clear",
  defaultHostingMode: "adapter-only",
};

export const SWEBENCH_LITE_ADAPTER: Adapter = {
  id: "swebench-lite",
  benchmarkId: SWEBENCH_LITE_BENCHMARK.id,
  adapterVersion: "0.1.0",
  fetchStrategy: "upstream-checkout",
  judgeCommand: ["python3", "-m", "swebench.harness.run_evaluation"],
  verificationCommands: [["python3", "-m", "swebench.harness.run_evaluation"]],
  supportedHostingModes: ["adapter-only"],
  dockerImageDigest: SWEBENCH_LITE_HARNESS_IMAGE_DIGEST,
  defaultResources: {
    timeoutSeconds: 2700,
    cpuCores: 2,
    memoryMb: 6144,
    networkPolicy: "blocked",
  },
};

export const SWEBENCH_LITE_DESCRIPTOR_HASH_MANIFEST: readonly SwebenchLiteManifestEntry[] = [
  {
    problemId: "swe-bench-lite-astropy-12907",
    upstreamTaskId: "astropy__astropy-12907",
    instanceId: "astropy__astropy-12907",
    repo: "astropy/astropy",
    baseCommit: "d16bfe05a744909de4b27f5875fe0d4ed41ce607",
    title: "SWE-bench Lite — astropy__astropy-12907",
    oracleDescriptorHash: "sha256:a65f563a256e5fa5799ef9815563c3e6cc318b9d515ce00f44a607611b41477a",
  },
];

export const SWEBENCH_LITE_PROBLEMS: Problem[] = SWEBENCH_LITE_DESCRIPTOR_HASH_MANIFEST.map((entry) => ({
  id: entry.problemId,
  benchmarkId: SWEBENCH_LITE_BENCHMARK.id,
  adapterId: SWEBENCH_LITE_ADAPTER.id,
  upstreamTaskId: entry.upstreamTaskId,
  title: entry.title,
  languageFrameworkTags: ["python", "swe-bench", "lite", "repo-patch", "scored-hidden"],
  hostingMode: "adapter-only",
  enabled: true,
  editableFilePaths: ["**/*"],
  scoringMode: "scored-hidden",
  oracleMetadata: {
    kind: "generated-private",
    hiddenRequired: true,
    oracleDescriptorHash: entry.oracleDescriptorHash,
  },
}));

export function listSwebenchLiteProblems(): readonly Problem[] {
  return SWEBENCH_LITE_PROBLEMS;
}

export function getSwebenchLiteProblem(problemId: string): Problem | undefined {
  return SWEBENCH_LITE_PROBLEMS.find((problem) => problem.id === problemId);
}

export function validateSwebenchLiteAdapterSeed(): void {
  const benchmark = validateBenchmark(SWEBENCH_LITE_BENCHMARK);
  if (!benchmark.ok) throw new Error(`Invalid SWE-bench Lite benchmark metadata: ${benchmark.issues.map((issue) => issue.code).join(", ")}`);
  const adapter = validateAdapter(SWEBENCH_LITE_ADAPTER, SWEBENCH_LITE_BENCHMARK);
  if (!adapter.ok) throw new Error(`Invalid SWE-bench Lite adapter metadata: ${adapter.issues.map((issue) => issue.code).join(", ")}`);
  for (const problem of SWEBENCH_LITE_PROBLEMS) {
    const result = validateProblem(problem, SWEBENCH_LITE_BENCHMARK, SWEBENCH_LITE_ADAPTER);
    if (!result.ok) throw new Error(`Invalid SWE-bench Lite problem ${problem.id}: ${result.issues.map((issue) => issue.code).join(", ")}`);
  }
}
