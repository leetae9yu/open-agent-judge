import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ContractViolation,
  approveRecording,
  createPatchSubmission,
  createSolutionRecording,
  promoteToPublicMemory,
  runAutomaticCheck,
  runGoldenTrustSlice,
  seedPermissiveCatalog,
  simulateSandboxVerification,
  validateBenchmark,
  validateProblem,
  type Benchmark,
} from "../src/index.ts";

describe("golden trust slice", () => {
  it("keeps the golden fixture slice demo-only and out of public promotion", () => {
    const result = runGoldenTrustSlice();

    assert.equal(result.catalog.benchmark.legalStatus, "approved");
    assert.equal(result.catalog.hostedProblem.hostingMode, "hosted");
    assert.equal(result.verification.result.passFail, "pass");
    assert.equal(result.recording.passFail, "pass");
    assert.equal(result.evidence.sandboxRerunCheck, "fail");
    assert.equal(result.review.trustedReviewerApprovalStatus, "approved");
    assert.throws(
      () => promoteToPublicMemory(result.recording, result.evidence, result.review),
      (error) => error instanceof ContractViolation && error.issues.some((entry) => entry.code === "publicMemory.scoring.scored"),
    );
  });

  it("blocks recording creation for failed patches", () => {
    const catalog = seedPermissiveCatalog();
    const submission = createPatchSubmission(catalog.hostedProblem, "bad-patch");
    const verification = simulateSandboxVerification(submission, catalog.adapter, "patch-apply-failed");

    assert.throws(
      () => createSolutionRecording(catalog, submission, verification),
      (error) => error instanceof ContractViolation && error.issues[0]?.code === "recording.source.notPassing",
    );
  });

  it("blocks recording creation for mismatched verification descriptors", () => {
    const catalog = seedPermissiveCatalog();
    const submission = createPatchSubmission(catalog.hostedProblem);
    const otherSubmission = createPatchSubmission(catalog.hostedProblem, "other-fix");
    const crossSubmission = simulateSandboxVerification(otherSubmission, catalog.adapter, "pass");

    assert.throws(
      () => createSolutionRecording(catalog, submission, crossSubmission),
      (error) => error instanceof ContractViolation && error.issues[0]?.code === "recording.source.notPassing",
    );

    const wrongJobId = simulateSandboxVerification(submission, catalog.adapter, "pass");
    wrongJobId.result.jobId = "job-from-another-run";
    assert.throws(
      () => createSolutionRecording(catalog, submission, wrongJobId),
      (error) => error instanceof ContractViolation && error.issues[0]?.code === "recording.source.notPassing",
    );

    const failedJobStatus = simulateSandboxVerification(submission, catalog.adapter, "pass");
    failedJobStatus.job.status = "failed";
    assert.throws(
      () => createSolutionRecording(catalog, submission, failedJobStatus),
      (error) => error instanceof ContractViolation && error.issues[0]?.code === "recording.source.notPassing",
    );
  });

  it("keeps unknown legal status out of the catalog", () => {
    const catalog = seedPermissiveCatalog();
    const unknown: Benchmark = { ...catalog.benchmark, legalStatus: "unknown" };
    const result = validateBenchmark(unknown);

    assert.equal(result.ok, false);
    assert.match(result.issues.map((entry) => entry.code).join("\n"), /legalStatus\.unknown/);
  });

  it("supports adapter-only problems as first-class catalog entries", () => {
    const catalog = seedPermissiveCatalog();
    const result = validateProblem(catalog.adapterOnlyProblem, catalog.benchmark, catalog.adapter);

    assert.equal(result.ok, true);
    assert.equal(catalog.adapterOnlyProblem.hostingMode, "adapter-only");
  });

  it("blocks public memory promotion when automatic rerun fails", () => {
    const catalog = seedPermissiveCatalog();
    const submission = createPatchSubmission(catalog.hostedProblem);
    const verification = simulateSandboxVerification(submission, catalog.adapter, "pass");
    const recording = createSolutionRecording(catalog, submission, verification);
    const failedRerun = simulateSandboxVerification(submission, catalog.adapter, "failed-tests", "rerun");
    const evidence = runAutomaticCheck(recording, failedRerun);
    const review = approveRecording(recording);

    assert.throws(
      () => promoteToPublicMemory(recording, evidence, review),
      (error) =>
        error instanceof ContractViolation &&
        error.issues.some((entry) => entry.code === "evidence.verification.pass" || entry.code === "evidence.rerun.pass"),
    );
  });

  it("fails automatic checks for mismatched pinned rerun descriptors", () => {
    const catalog = seedPermissiveCatalog();
    const submission = createPatchSubmission(catalog.hostedProblem);
    const verification = simulateSandboxVerification(submission, catalog.adapter, "pass");
    const recording = createSolutionRecording(catalog, submission, verification);

    const mismatchedCommit = simulateSandboxVerification(submission, catalog.adapter, "pass", "rerun-commit");
    mismatchedCommit.job.upstreamCommit = "different-commit";
    assert.equal(runAutomaticCheck(recording, mismatchedCommit).sandboxRerunCheck, "fail");

    const mismatchedDigest = simulateSandboxVerification(submission, catalog.adapter, "pass", "rerun-digest");
    mismatchedDigest.job.dockerImageDigest = "python@sha256:2222222222222222222222222222222222222222222222222222222222222222";
    assert.equal(runAutomaticCheck(recording, mismatchedDigest).sandboxRerunCheck, "fail");

    const mismatchedResources = simulateSandboxVerification(submission, catalog.adapter, "pass", "rerun-resources");
    mismatchedResources.job.resources = { ...mismatchedResources.job.resources, networkPolicy: "reviewed-exception" };
    assert.equal(runAutomaticCheck(recording, mismatchedResources).sandboxRerunCheck, "fail");

    const mismatchedJobId = simulateSandboxVerification(submission, catalog.adapter, "pass", "rerun-job-id");
    mismatchedJobId.result.jobId = "wrong-job";
    assert.equal(runAutomaticCheck(recording, mismatchedJobId).sandboxRerunCheck, "fail");
  });
  it("rejects reuse of the original job/result as sandbox rerun evidence", () => {
    const catalog = seedPermissiveCatalog();
    const submission = createPatchSubmission(catalog.hostedProblem);
    const verification = simulateSandboxVerification(submission, catalog.adapter, "pass");
    const recording = createSolutionRecording(catalog, submission, verification);
    const evidence = runAutomaticCheck(recording, verification);

    assert.equal(evidence.sandboxRerunCheck, "fail");
    assert.throws(
      () => promoteToPublicMemory(recording, evidence, approveRecording(recording)),
      (error) => error instanceof ContractViolation && error.issues.some((entry) => entry.code === "evidence.rerun.pass" || entry.code === "evidence.rerunJob.distinct"),
    );
  });

  it("blocks public memory promotion without trusted reviewer approval", () => {
    const catalog = seedPermissiveCatalog();
    const submission = createPatchSubmission(catalog.hostedProblem);
    const verification = simulateSandboxVerification(submission, catalog.adapter, "pass");
    const recording = createSolutionRecording(catalog, submission, verification);
    const evidence = runAutomaticCheck(recording, simulateSandboxVerification(submission, catalog.adapter, "pass", "rerun"));
    const review = {
      id: "review-pending",
      recordingId: recording.id,
      automaticCheckStatus: "pass" as const,
      trustedReviewerApprovalStatus: "pending" as const,
    };

    assert.throws(
      () => promoteToPublicMemory(recording, evidence, review),
      (error) => error instanceof ContractViolation && error.issues.some((entry) => entry.code === "review.trusted.approved"),
    );
  });
});
