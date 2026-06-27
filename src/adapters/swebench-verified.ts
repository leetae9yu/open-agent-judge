import type { Adapter, Benchmark, Problem } from "../contracts/types.ts";
import { validateAdapter, validateBenchmark, validateProblem } from "../contracts/validators.ts";

export const SWEBENCH_VERIFIED_DATASET_NAME = "princeton-nlp/SWE-bench_Verified";
export const SWEBENCH_VERIFIED_DATASET_REVISION = "c104f840cc67f8b6eec6f759ebc8b2693d585d4a";
export const SWEBENCH_VERIFIED_HARNESS_COMMIT = "f7bbbb2ccdf479001d6467c9e34af59e44a840f9";
export const SWEBENCH_VERIFIED_HARNESS_IMAGE_DIGEST =
  "swebench/sweb.eval.x86_64.astropy_1776_astropy-12907@sha256:f3f63bb87d581c0e7b47f900dd82165b71040e1758d3c29e915e2b18da9baf63";
export const SWEBENCH_VERIFIED_DESCRIPTOR_REVISION = "swe-bench-verified-official-1-v1";
export const SWEBENCH_VERIFIED_PREDICTION_JSONL_SCHEMA_HASH = "sha256:1f4f2da592ab5373104554cc3c55408feb0209c9fd32ff3bc603e81ad4933236";

export interface SwebenchVerifiedManifestEntry {
  problemId: string;
  upstreamTaskId: string;
  instanceId: string;
  repo: string;
  baseCommit: string;
  title: string;
  oracleDescriptorHash: string;
}

export const SWEBENCH_VERIFIED_BENCHMARK: Benchmark = {
  id: "swe-bench-verified",
  name: "SWE-bench Verified",
  upstreamUrl: "https://github.com/SWE-bench/SWE-bench",
  upstreamCommitOrVersion: SWEBENCH_VERIFIED_HARNESS_COMMIT,
  licenseId: "MIT",
  legalStatus: "approved",
  redistributionRights: "clear",
  defaultHostingMode: "adapter-only",
};

export const SWEBENCH_VERIFIED_ADAPTER: Adapter = {
  id: "swebench-verified",
  benchmarkId: SWEBENCH_VERIFIED_BENCHMARK.id,
  adapterVersion: "0.1.0",
  fetchStrategy: "upstream-checkout",
  judgeCommand: ["python3", "-m", "swebench.harness.run_evaluation"],
  verificationCommands: [["python3", "-m", "swebench.harness.run_evaluation"]],
  supportedHostingModes: ["adapter-only"],
  dockerImageDigest: SWEBENCH_VERIFIED_HARNESS_IMAGE_DIGEST,
  defaultResources: {
    timeoutSeconds: 2700,
    cpuCores: 2,
    memoryMb: 6144,
    networkPolicy: "blocked",
  },
};

export const SWEBENCH_VERIFIED_DESCRIPTOR_HASH_MANIFEST: readonly SwebenchVerifiedManifestEntry[] = [
  {
    problemId: "swe-bench-verified-astropy-12907",
    upstreamTaskId: "astropy__astropy-12907",
    instanceId: "astropy__astropy-12907",
    repo: "astropy/astropy",
    baseCommit: "d16bfe05a744909de4b27f5875fe0d4ed41ce607",
    title: "SWE-bench Verified — astropy__astropy-12907",
    oracleDescriptorHash: "sha256:06580578f0689968a04e7b2022007461e55147b4322e3c9f7b0ea29d5345e619",
  },
];

export const SWEBENCH_VERIFIED_PROBLEMS: Problem[] = SWEBENCH_VERIFIED_DESCRIPTOR_HASH_MANIFEST.map((entry) => ({
  id: entry.problemId,
  benchmarkId: SWEBENCH_VERIFIED_BENCHMARK.id,
  adapterId: SWEBENCH_VERIFIED_ADAPTER.id,
  upstreamTaskId: entry.upstreamTaskId,
  title: entry.title,
  languageFrameworkTags: ["python", "swe-bench", "verified", "repo-patch", "scored-hidden"],
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

export function listSwebenchVerifiedProblems(): readonly Problem[] {
  return SWEBENCH_VERIFIED_PROBLEMS;
}

export function getSwebenchVerifiedProblem(problemId: string): Problem | undefined {
  return SWEBENCH_VERIFIED_PROBLEMS.find((problem) => problem.id === problemId);
}

export function validateSwebenchVerifiedAdapterSeed(): void {
  const benchmark = validateBenchmark(SWEBENCH_VERIFIED_BENCHMARK);
  if (!benchmark.ok) throw new Error(`Invalid SWE-bench Verified benchmark metadata: ${benchmark.issues.map((issue) => issue.code).join(", ")}`);
  const adapter = validateAdapter(SWEBENCH_VERIFIED_ADAPTER, SWEBENCH_VERIFIED_BENCHMARK);
  if (!adapter.ok) throw new Error(`Invalid SWE-bench Verified adapter metadata: ${adapter.issues.map((issue) => issue.code).join(", ")}`);
  for (const problem of SWEBENCH_VERIFIED_PROBLEMS) {
    const result = validateProblem(problem, SWEBENCH_VERIFIED_BENCHMARK, SWEBENCH_VERIFIED_ADAPTER);
    if (!result.ok) throw new Error(`Invalid SWE-bench Verified problem ${problem.id}: ${result.issues.map((issue) => issue.code).join(", ")}`);
  }
}
