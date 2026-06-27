import type { Adapter, Benchmark, Problem } from "../contracts/types.ts";
import { validateAdapter, validateBenchmark, validateProblem } from "../contracts/validators.ts";

export const QUIXBUGS_UPSTREAM_COMMIT = "4257f44b0ff1181dedaedee6a447e133219fcebf";
export const QUIXBUGS_UPSTREAM_URL = "https://github.com/jkoppel/QuixBugs";
export const QUIXBUGS_PYTHON_SUBSET_DESCRIPTOR_REVISION = "quixbugs-python-subset-10-v1";
export const QUIXBUGS_HIDDEN_COMMAND_ID = "pytest-hidden";

export interface QuixBugsPythonManifestEntry {
  problemId: string;
  upstreamTaskId: string;
  editableFilePath: string;
  commandId: string;
  title: string;
  oracleDescriptorHash: string;
}

export interface QuixBugsSelectionMetadata {
  subsetId: string;
  language: "python";
  upstreamCommit: string;
  selectedBy: string;
  selectedUpstreamOrder: readonly string[];
  inclusionCriteria: readonly string[];
  exclusionCriteria: readonly string[];
  deferredScope: readonly string[];
}

export const QUIXBUGS_BENCHMARK: Benchmark = {
  id: "quixbugs",
  name: "QuixBugs",
  upstreamUrl: QUIXBUGS_UPSTREAM_URL,
  upstreamCommitOrVersion: QUIXBUGS_UPSTREAM_COMMIT,
  licenseId: "MIT",
  legalStatus: "approved",
  redistributionRights: "clear",
  defaultHostingMode: "hosted",
};

export const QUIXBUGS_ADAPTER: Adapter = {
  id: "quixbugs-python",
  benchmarkId: QUIXBUGS_BENCHMARK.id,
  adapterVersion: "0.1.0",
  fetchStrategy: "upstream-checkout",
  judgeCommand: ["python3", "-m", "pytest", "tests"],
  verificationCommands: [["python3", "-m", "pytest", "tests"]],
  supportedHostingModes: ["hosted"],
  dockerImageDigest: "python:3.12.11-slim-bookworm@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7",
  defaultResources: {
    timeoutSeconds: 120,
    cpuCores: 1,
    memoryMb: 1024,
    networkPolicy: "blocked",
  },
};

export const QUIXBUGS_PYTHON_SUBSET_SELECTION: QuixBugsSelectionMetadata = {
  subsetId: QUIXBUGS_PYTHON_SUBSET_DESCRIPTOR_REVISION,
  language: "python",
  upstreamCommit: QUIXBUGS_UPSTREAM_COMMIT,
  selectedBy: "First 10 approved Python QuixBugs tasks in the requested stable upstream order.",
  selectedUpstreamOrder: [
    "bitcount",
    "breadth_first_search",
    "bucketsort",
    "depth_first_search",
    "detect_cycle",
    "find_first_in_sorted",
    "find_in_sorted",
    "flatten",
    "gcd",
    "get_factors",
  ],
  inclusionCriteria: [
    "Python implementation under python_programs/<name>.py at the pinned upstream commit.",
    "Single editable buggy source file per task.",
    "Hidden scoring can be represented as a command-hidden-tests descriptor without publishing test source or cases.",
  ],
  exclusionCriteria: [
    "Java QuixBugs targets are deferred until the Python command-hidden flow is accepted.",
    "Tasks outside the first subset-10 slice are deferred to keep first-release scoring cost bounded.",
    "Tests, harness files, generated artifacts, and non-allowlisted paths are not editable targets.",
  ],
  deferredScope: ["remaining-python-programs", "java-programs", "public-tests", "hidden-harness"],
};

export const QUIXBUGS_DESCRIPTOR_EXPECTED_SHAPE = {
  schemaVersion: 2,
  oracleKind: "command-hidden-tests",
  commandId: QUIXBUGS_HIDDEN_COMMAND_ID,
  descriptorRevision: QUIXBUGS_PYTHON_SUBSET_DESCRIPTOR_REVISION,
  expectedExitCode: 0,
  requiredFields: [
    "problemId",
    "benchmarkId",
    "adapterId",
    "upstreamTaskId",
    "allowedTargets",
    "hiddenTestBundleHash",
    "testSourceHash",
    "evidencePolicy",
    "testSource",
    "fixtureRef",
  ],
  hiddenBundleHashPolicy: "For command-hidden-tests descriptors, hiddenTestBundleHash must equal testSourceHash; private testSource is never exported in the public catalog.",
  publicCatalogPolicy: "Expose descriptor hashes and allowed editable target paths only; do not publish hidden test source, cases, bundles, or private descriptor JSON.",
} as const;

export const QUIXBUGS_DESCRIPTOR_HASH_MANIFEST: readonly QuixBugsPythonManifestEntry[] = [
  {
    problemId: "quixbugs-python-bitcount",
    upstreamTaskId: "bitcount",
    editableFilePath: "python_programs/bitcount.py",
    commandId: QUIXBUGS_HIDDEN_COMMAND_ID,
    title: "QuixBugs Python — bitcount",
    oracleDescriptorHash: "sha256:31d9ae1641a675a6c58bf5d841c16c3aef6eb5e204a6ea78b2f4984ab08477de",
  },
  {
    problemId: "quixbugs-python-breadth-first-search",
    upstreamTaskId: "breadth_first_search",
    editableFilePath: "python_programs/breadth_first_search.py",
    commandId: QUIXBUGS_HIDDEN_COMMAND_ID,
    title: "QuixBugs Python — breadth_first_search",
    oracleDescriptorHash: "sha256:27b71a1b6cc5bd9ee44b264b2d3db9e7a9fcabc5c19fc4f7a3a9d8e24a8de908",
  },
  {
    problemId: "quixbugs-python-bucketsort",
    upstreamTaskId: "bucketsort",
    editableFilePath: "python_programs/bucketsort.py",
    commandId: QUIXBUGS_HIDDEN_COMMAND_ID,
    title: "QuixBugs Python — bucketsort",
    oracleDescriptorHash: "sha256:aa433fe39a0b419922c34c6ff51b651311e4890f8157056fe2e9ce2195726e4a",
  },
  {
    problemId: "quixbugs-python-depth-first-search",
    upstreamTaskId: "depth_first_search",
    editableFilePath: "python_programs/depth_first_search.py",
    commandId: QUIXBUGS_HIDDEN_COMMAND_ID,
    title: "QuixBugs Python — depth_first_search",
    oracleDescriptorHash: "sha256:8ff94074db37aafe4d38047be8a3db8bcd2bb72b6415600a4a7bd641d910cd9b",
  },
  {
    problemId: "quixbugs-python-detect-cycle",
    upstreamTaskId: "detect_cycle",
    editableFilePath: "python_programs/detect_cycle.py",
    commandId: QUIXBUGS_HIDDEN_COMMAND_ID,
    title: "QuixBugs Python — detect_cycle",
    oracleDescriptorHash: "sha256:88705e2dcb2a4df45337b2204a7e03c24d42165dc7a63762b03abefbd7c0eb74",
  },
  {
    problemId: "quixbugs-python-find-first-in-sorted",
    upstreamTaskId: "find_first_in_sorted",
    editableFilePath: "python_programs/find_first_in_sorted.py",
    commandId: QUIXBUGS_HIDDEN_COMMAND_ID,
    title: "QuixBugs Python — find_first_in_sorted",
    oracleDescriptorHash: "sha256:ba2fde3d797b66246dddb47541fc5741d5e477d8b3d6521357bfa4a7804109e6",
  },
  {
    problemId: "quixbugs-python-find-in-sorted",
    upstreamTaskId: "find_in_sorted",
    editableFilePath: "python_programs/find_in_sorted.py",
    commandId: QUIXBUGS_HIDDEN_COMMAND_ID,
    title: "QuixBugs Python — find_in_sorted",
    oracleDescriptorHash: "sha256:3df6dcfb534225cfae426a2847d5b3180b0ec24165a5d46539b7cdd859f1f01d",
  },
  {
    problemId: "quixbugs-python-flatten",
    upstreamTaskId: "flatten",
    editableFilePath: "python_programs/flatten.py",
    commandId: QUIXBUGS_HIDDEN_COMMAND_ID,
    title: "QuixBugs Python — flatten",
    oracleDescriptorHash: "sha256:171cf4a6be14511b67ec0e7e55147cbb8ea4eeb545c59bf854dd7d4836e0e4de",
  },
  {
    problemId: "quixbugs-python-gcd",
    upstreamTaskId: "gcd",
    editableFilePath: "python_programs/gcd.py",
    commandId: QUIXBUGS_HIDDEN_COMMAND_ID,
    title: "QuixBugs Python — gcd",
    oracleDescriptorHash: "sha256:00ee06ab90be515273f22c0bb0a836c4e23908c754aec7177cf088da89c024dd",
  },
  {
    problemId: "quixbugs-python-get-factors",
    upstreamTaskId: "get_factors",
    editableFilePath: "python_programs/get_factors.py",
    commandId: QUIXBUGS_HIDDEN_COMMAND_ID,
    title: "QuixBugs Python — get_factors",
    oracleDescriptorHash: "sha256:7d861c815dc390a35a9cc92aa7300dc12d133449fc7c410fafca9034799220c8",
  },
];

export const QUIXBUGS_ALLOWED_TARGETS_BY_PROBLEM = Object.fromEntries(
  QUIXBUGS_DESCRIPTOR_HASH_MANIFEST.map((entry) => [entry.problemId, [entry.editableFilePath] as const]),
) as Record<string, readonly string[]>;

export const QUIXBUGS_PROBLEMS: Problem[] = QUIXBUGS_DESCRIPTOR_HASH_MANIFEST.map((entry) => ({
  id: entry.problemId,
  benchmarkId: QUIXBUGS_BENCHMARK.id,
  adapterId: QUIXBUGS_ADAPTER.id,
  upstreamTaskId: entry.upstreamTaskId,
  title: entry.title,
  languageFrameworkTags: ["python", "quixbugs", "bug-fix", "scored-hidden"],
  hostingMode: "hosted",
  enabled: true,
  editableFilePaths: [entry.editableFilePath],
  scoringMode: "scored-hidden",
  oracleMetadata: {
    kind: "generated-private",
    hiddenRequired: true,
    oracleDescriptorHash: entry.oracleDescriptorHash,
  },
}));

export function listQuixBugsProblems(): readonly Problem[] {
  return QUIXBUGS_PROBLEMS;
}

export function getQuixBugsProblem(problemId: string): Problem | undefined {
  return QUIXBUGS_PROBLEMS.find((problem) => problem.id === problemId);
}

export function validateQuixBugsAdapterSeed(): void {
  const benchmark = validateBenchmark(QUIXBUGS_BENCHMARK);
  if (!benchmark.ok) throw new Error(`Invalid QuixBugs benchmark: ${benchmark.issues.map((issue) => issue.code).join(",")}`);

  const adapter = validateAdapter(QUIXBUGS_ADAPTER, QUIXBUGS_BENCHMARK);
  if (!adapter.ok) throw new Error(`Invalid QuixBugs adapter: ${adapter.issues.map((issue) => issue.code).join(",")}`);

  if (QUIXBUGS_PROBLEMS.length !== 10) throw new Error(`Invalid QuixBugs subset size: ${QUIXBUGS_PROBLEMS.length}`);

  for (const problem of QUIXBUGS_PROBLEMS) {
    const result = validateProblem(problem, QUIXBUGS_BENCHMARK, QUIXBUGS_ADAPTER);
    if (!result.ok) throw new Error(`Invalid QuixBugs problem ${problem.id}: ${result.issues.map((issue) => issue.code).join(",")}`);
  }
}
