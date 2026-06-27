import type {
  ApprovedDifficulty,
  DifficultyVote,
  DiscussionPost,
  LeaderboardEntry,
  McpSearchResult,
  PatchSubmission,
  PublicMemoryEntry,
  SolutionRecording,
  TagSuggestion,
  ValidationIssue,
} from "./contracts/types.ts";
import { ContractViolation, type VerificationRun } from "./golden-trust-slice.ts";
import { isLeaderboardEligible, validateMcpSearchQuery, validateMcpSearchResult } from "./contracts/validators.ts";

export interface ChecklistCase {
  id: string;
  publicMemoryEntryId: string;
  recordingId: string;
  languageFramework: string;
  errorSignature: string;
  actionChecklist: readonly string[];
  sourceRecordingIds: readonly string[];
}

export interface PublicMemoryIndex {
  entries: readonly PublicMemoryEntry[];
  checklistCases: readonly ChecklistCase[];
}

function assertValid(context: string, issues: ValidationIssue[]): void {
  if (issues.length > 0) throw new ContractViolation(`${context} failed validation`, issues);
}

function present(value: string): boolean {
  return value.trim().length > 0;
}

function stableId(prefix: string, seed: string): string {
  return `${prefix}-${seed.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}`;
}

export function createDiscussionPost(problemId: string, authorId: string, markdown: string): DiscussionPost {
  if (!present(problemId) || !present(authorId) || !present(markdown)) {
    throw new ContractViolation("discussion post", [
      { code: "discussion.required", message: "Problem id, author id, and markdown are required." },
    ]);
  }

  return {
    id: stableId("discussion", `${problemId}-${authorId}-${markdown.slice(0, 24)}`),
    problemId,
    authorId,
    markdown,
    moderationState: "visible",
  };
}

export function suggestTag(targetId: string, targetType: "problem" | "recording", tag: string, suggestedBy: string): TagSuggestion {
  if (!present(targetId) || !present(tag) || !present(suggestedBy)) {
    throw new ContractViolation("tag suggestion", [
      { code: "tag.required", message: "Target, tag, and suggester are required." },
    ]);
  }

  return {
    id: stableId("tag", `${targetId}-${tag}`),
    targetId,
    targetType,
    tag,
    suggestedBy,
    reviewerDecision: "pending",
  };
}

export function approveTagSuggestion(suggestion: TagSuggestion): TagSuggestion {
  return { ...suggestion, reviewerDecision: "approved" };
}

export function voteDifficulty(problemId: string, voterId: string, value: 1 | 2 | 3 | 4 | 5): DifficultyVote {
  if (!present(problemId) || !present(voterId)) {
    throw new ContractViolation("difficulty vote", [
      { code: "difficulty.required", message: "Problem id and voter id are required." },
    ]);
  }

  return {
    id: stableId("difficulty-vote", `${problemId}-${voterId}`),
    problemId,
    voterId,
    value,
  };
}

export function approveDifficulty(problemId: string, reviewerId: string, votes: readonly DifficultyVote[]): ApprovedDifficulty {
  const matchingVotes = votes.filter((vote) => vote.problemId === problemId);
  if (!present(problemId) || !present(reviewerId) || matchingVotes.length === 0) {
    throw new ContractViolation("difficulty approval", [
      { code: "difficulty.approval.required", message: "Reviewer approval requires at least one vote for the problem." },
    ]);
  }
  const average = matchingVotes.reduce((sum, vote) => sum + vote.value, 0) / matchingVotes.length;
  const approvedValue = Math.min(5, Math.max(1, Math.round(average))) as 1 | 2 | 3 | 4 | 5;

  return { problemId, approvedValue, reviewerId };
}

export function createLeaderboardEntry(submission: PatchSubmission, verification: VerificationRun): LeaderboardEntry {
  const provenanceValid =
    verification.job.submissionId === submission.id &&
    verification.result.jobId === verification.job.id &&
    verification.job.status === "passed";
  const entry: LeaderboardEntry = {
    id: stableId("leaderboard", submission.id),
    submissionId: submission.id,
    problemId: submission.problemId,
    reproducibleResult: provenanceValid,
    publicMetrics: {
      ...submission.publicMetrics,
      passFail: verification.result.passFail,
      runtimeMs: verification.result.runtimeMs,
    },
    eligibilityStatus: "eligible",
  };
  const validation = isLeaderboardEligible(entry, verification.result);
  if (!validation.ok) {
    return {
      ...entry,
      eligibilityStatus: "ineligible",
      ineligibilityReason: validation.issues.map((item) => item.code).join(","),
    };
  }
  return entry;
}

export function createChecklistCase(
  publicMemory: PublicMemoryEntry,
  recording: SolutionRecording,
  input: {
    languageFramework: string;
    errorSignature: string;
    actionChecklist: readonly string[];
  },
): ChecklistCase {
  if (!present(input.languageFramework) || !present(input.errorSignature) || input.actionChecklist.length === 0) {
    throw new ContractViolation("checklist case", [
      { code: "checklist.required", message: "Checklist cases require language/framework, error signature, and actions." },
    ]);
  }
  if (publicMemory.recordingId !== recording.id) {
    throw new ContractViolation("checklist case", [
      { code: "checklist.recording.mismatch", message: "Checklist case must reference the public memory recording." },
    ]);
  }

  return {
    id: stableId("checklist", recording.id),
    publicMemoryEntryId: publicMemory.id,
    recordingId: recording.id,
    languageFramework: input.languageFramework,
    errorSignature: input.errorSignature,
    actionChecklist: input.actionChecklist,
    sourceRecordingIds: [recording.id],
  };
}

export function createPublicMemoryIndex(entries: readonly PublicMemoryEntry[], checklistCases: readonly ChecklistCase[]): PublicMemoryIndex {
  const entryIds = new Set(entries.map((entry) => entry.id));
  const checklistIds = new Set(checklistCases.map((checklist) => checklist.id));
  const invalid = checklistCases.find((checklist) => !entryIds.has(checklist.publicMemoryEntryId));
  if (invalid) {
    throw new ContractViolation("public memory index", [
      { code: "memory.checklist.entryMissing", message: "Checklist case must reference an indexed public memory entry." },
    ]);
  }
  const entryWithMissingChecklist = entries.find((entry) =>
    entry.sourceChecklistCaseIds.some((checklistId) => !checklistIds.has(checklistId)),
  );
  if (entryWithMissingChecklist) {
    throw new ContractViolation("public memory index", [
      { code: "memory.checklist.sourceMissing", message: "Public memory sourceChecklistCaseIds must reference indexed checklist cases." },
    ]);
  }
  const mismatchedChecklist = checklistCases.find((checklist) => {
    const entry = entries.find((candidate) => candidate.id === checklist.publicMemoryEntryId);
    return !entry || entry.recordingId !== checklist.recordingId || !checklist.sourceRecordingIds.includes(entry.recordingId);
  });
  if (mismatchedChecklist) {
    throw new ContractViolation("public memory index", [
      { code: "memory.checklist.recordingMismatch", message: "Checklist case must match its public memory recording and source ids." },
    ]);
  }
  return { entries, checklistCases };
}

export function searchPublicMemory(index: PublicMemoryIndex, rawQuery: Record<string, unknown>): McpSearchResult[] {
  assertValid("MCP query", validateMcpSearchQuery(rawQuery).issues);
  const errorSignature = String(rawQuery.errorSignature).toLowerCase();
  const languageFramework = String(rawQuery.languageFramework).toLowerCase();

  return index.checklistCases
    .filter((checklist) => {
      const signatureMatches =
        checklist.errorSignature.toLowerCase().includes(errorSignature) ||
        errorSignature.includes(checklist.errorSignature.toLowerCase());
      return checklist.languageFramework.toLowerCase() === languageFramework && signatureMatches;
    })
    .map((checklist) => {
      const entry = index.entries.find((candidate) => candidate.id === checklist.publicMemoryEntryId);
      if (!entry) {
        throw new ContractViolation("MCP search", [
          { code: "mcp.memory.entryMissing", message: "MCP search results require an indexed public memory entry." },
        ]);
      }
      const result: McpSearchResult = {
        publicRecordingLink: entry.publicSlug,
        actionChecklist: checklist.actionChecklist,
        sourceRecordingIds: checklist.sourceRecordingIds,
        applicabilityExplanation: `Matched ${checklist.languageFramework} case for ${checklist.errorSignature}.`,
      };
      assertValid("MCP result", validateMcpSearchResult(result as unknown as Record<string, unknown>).issues);
      return result;
    });
}
