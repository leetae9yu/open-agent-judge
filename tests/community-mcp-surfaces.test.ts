import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ContractViolation,
  approveDifficulty,
  approveTagSuggestion,
  createChecklistCase,
  createDiscussionPost,
  createLeaderboardEntry,
  createPublicMemoryIndex,
  runGoldenTrustSlice,
  searchPublicMemory,
  suggestTag,
  validateMcpSearchQuery,
  voteDifficulty,
} from "../src/index.ts";
function demoMemoryFor(golden: ReturnType<typeof runGoldenTrustSlice>) {
  const checklistId = `checklist-${golden.recording.id.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}`;
  return {
    id: `public-memory-${golden.recording.id}`,
    recordingId: golden.recording.id,
    publicSlug: `/recordings/${golden.recording.id}`,
    sourceChecklistCaseIds: [checklistId],
  };
}

describe("community, leaderboard, and MCP surfaces", () => {
  it("runs catalog to public memory to MCP checklist end-to-end", () => {
    const golden = runGoldenTrustSlice();
    const memory = demoMemoryFor(golden);
    const discussion = createDiscussionPost(golden.catalog.hostedProblem.id, "user-1", "This fix pattern applies to empty inputs.");
    const tag = approveTagSuggestion(suggestTag(golden.recording.id, "recording", "edge-case", "user-1"));
    const vote = voteDifficulty(golden.catalog.hostedProblem.id, "user-1", 3);
    const difficulty = approveDifficulty(golden.catalog.hostedProblem.id, "trusted-reviewer-1", [vote]);
    const leaderboard = createLeaderboardEntry(golden.submission, golden.verification);
    const checklist = createChecklistCase(memory, golden.recording, {
      languageFramework: "python/pytest",
      errorSignature: "edge case failure",
      actionChecklist: [
        "Open the referenced public recording.",
        "Compare the failing edge case with the verified fix description.",
        "Run the pinned verification command before promoting a new recording.",
      ],
    });
    const index = createPublicMemoryIndex([memory], [checklist]);
    const results = searchPublicMemory(index, {
      errorSignature: "edge case failure",
      languageFramework: "python/pytest",
      stackTraceSummary: "Assertion failed in edge-case test.",
    });

    assert.equal(discussion.moderationState, "visible");
    assert.equal(tag.reviewerDecision, "approved");
    assert.equal(difficulty.approvedValue, 3);
    assert.equal(leaderboard.eligibilityStatus, "eligible");
    assert.ok(memory.sourceChecklistCaseIds.includes(checklist.id));
    assert.equal(results.length, 1);
    assert.equal(results[0]?.publicRecordingLink, memory.publicSlug);
    assert.deepEqual(results[0]?.sourceRecordingIds, [golden.recording.id]);
    assert.ok(results[0]?.actionChecklist.some((item) => item.includes("pinned verification")));
  });

  it("marks failed runner results leaderboard-ineligible", () => {
    const golden = runGoldenTrustSlice();
    const failedVerification = {
      ...golden.verification,
      result: { ...golden.verification.result, passFail: "fail" as const, exitCode: 1 },
    };
    const leaderboard = createLeaderboardEntry(golden.submission, failedVerification);

    assert.equal(leaderboard.eligibilityStatus, "ineligible");
    assert.match(leaderboard.ineligibilityReason ?? "", /leaderboard\.runner\.pass/);
  });

  it("marks mismatched runner provenance leaderboard-ineligible", () => {
    const golden = runGoldenTrustSlice();
    const mismatchedVerification = {
      ...golden.verification,
      job: { ...golden.verification.job, submissionId: "other-submission" },
    };
    const leaderboard = createLeaderboardEntry(golden.submission, mismatchedVerification);

    assert.equal(leaderboard.eligibilityStatus, "ineligible");
    assert.match(leaderboard.ineligibilityReason ?? "", /leaderboard\.reproducible\.required/);
  });

  it("rejects checklist cases that do not belong to the public memory recording", () => {
    const golden = runGoldenTrustSlice();
    const memory = demoMemoryFor(golden);
    const wrongPublicMemory = { ...memory, recordingId: "other-recording" };

    assert.throws(
      () =>
        createChecklistCase(wrongPublicMemory, golden.recording, {
          languageFramework: "python/pytest",
          errorSignature: "edge case failure",
          actionChecklist: ["Use the verified recording."],
        }),
      (error) => error instanceof ContractViolation && error.issues[0]?.code === "checklist.recording.mismatch",
    );
  });

  it("rejects public memory indexes with orphan checklist cases", () => {
    const golden = runGoldenTrustSlice();
    const memory = demoMemoryFor(golden);
    const checklist = createChecklistCase(memory, golden.recording, {
      languageFramework: "python/pytest",
      errorSignature: "edge case failure",
      actionChecklist: ["Use the verified recording."],
    });

    assert.throws(
      () => createPublicMemoryIndex([], [checklist]),
      (error) => error instanceof ContractViolation && error.issues[0]?.code === "memory.checklist.entryMissing",
    );
  });

  it("rejects public memory indexes when entry source checklist ids are orphaned", () => {
    const golden = runGoldenTrustSlice();
    const memory = demoMemoryFor(golden);
    const checklist = createChecklistCase(memory, golden.recording, {
      languageFramework: "python/pytest",
      errorSignature: "edge case failure",
      actionChecklist: ["Use the verified recording."],
    });
    const entryWithMissingSource = { ...memory, sourceChecklistCaseIds: ["missing-checklist"] };

    assert.throws(
      () => createPublicMemoryIndex([entryWithMissingSource], [checklist]),
      (error) => error instanceof ContractViolation && error.issues[0]?.code === "memory.checklist.sourceMissing",
    );
  });

  it("requires both framework and error signature for MCP search matches", () => {
    const golden = runGoldenTrustSlice();
    const memory = demoMemoryFor(golden);
    const checklist = createChecklistCase(memory, golden.recording, {
      languageFramework: "python/pytest",
      errorSignature: "edge case failure",
      actionChecklist: ["Use the verified recording."],
    });
    const index = createPublicMemoryIndex([memory], [checklist]);

    assert.equal(
      searchPublicMemory(index, {
        errorSignature: "database connection failure",
        languageFramework: "python/pytest",
      }).length,
      0,
    );
  });

  it("throws instead of synthesizing MCP links for missing public memory entries", () => {
    const golden = runGoldenTrustSlice();
    const memory = demoMemoryFor(golden);
    const checklist = createChecklistCase(memory, golden.recording, {
      languageFramework: "python/pytest",
      errorSignature: "edge case failure",
      actionChecklist: ["Use the verified recording."],
    });

    assert.throws(
      () => searchPublicMemory({ entries: [], checklistCases: [checklist] }, {
        errorSignature: "edge case failure",
        languageFramework: "python/pytest",
      }),
      (error) => error instanceof ContractViolation && error.issues[0]?.code === "mcp.memory.entryMissing",
    );
  });

  it("keeps MCP search read-only and input constrained", () => {
    assert.equal(
      validateMcpSearchQuery({
        errorSignature: "edge case failure",
        languageFramework: "python/pytest",
        sourceCode: "print('secret')",
      }).ok,
      false,
    );

    const golden = runGoldenTrustSlice();
    const memory = demoMemoryFor(golden);
    const checklist = createChecklistCase(memory, golden.recording, {
      languageFramework: "python/pytest",
      errorSignature: "edge case failure",
      actionChecklist: ["Use the verified recording."],
    });
    const index = createPublicMemoryIndex([memory], [checklist]);

    assert.throws(
      () =>
        searchPublicMemory(index, {
          errorSignature: "edge case failure",
          languageFramework: "python/pytest",
          applyPatch: true,
        }),
      (error) => error instanceof ContractViolation && error.issues.some((entry) => entry.code === "mcp.query.key.forbidden"),
    );
  });

  it("requires reviewer-backed difficulty approval and non-empty discussion content", () => {
    assert.throws(
      () => approveDifficulty("humaneval-001", "trusted-reviewer-1", []),
      (error) => error instanceof ContractViolation && error.issues[0]?.code === "difficulty.approval.required",
    );
    assert.throws(
      () => createDiscussionPost("humaneval-001", "user-1", ""),
      (error) => error instanceof ContractViolation && error.issues[0]?.code === "discussion.required",
    );
  });
});
