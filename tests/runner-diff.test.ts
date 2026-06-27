import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ContractViolation, applyUnifiedDiff, parseUnifiedDiff } from "../src/index.ts";


function withWorktree(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "agentoj-diff-test-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function assertPatchIssue(run: () => void, code: string): void {
  assert.throws(
    run,
    (error) => error instanceof ContractViolation && error.issues.some((issue) => issue.code === code),
  );
}


describe("canonical unified diff parsing and application", () => {
  it("reports canonical metadata for modify, add, and delete targets", () => {
    const patch = [
      "diff --git a/solution.py b/solution.py",
      "--- a/solution.py",
      "+++ b/solution.py",
      "@@ -1,2 +1,2 @@",
      " def candidate(xs):",
      "-    return None",
      "+    return xs[0]",
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+alpha",
      "+beta",
      "diff --git a/old.txt b/old.txt",
      "deleted file mode 100644",
      "--- a/old.txt",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-remove me",
      "",
    ].join("\n");

    const parsed = parseUnifiedDiff(patch);
    assert.deepEqual(
      parsed.map((file) => ({ path: file.path, changeType: file.changeType, locAdded: file.locAdded, locDeleted: file.locDeleted })),
      [
        { path: "solution.py", changeType: "modify", locAdded: 1, locDeleted: 1 },
        { path: "new.txt", changeType: "add", locAdded: 2, locDeleted: 0 },
        { path: "old.txt", changeType: "delete", locAdded: 0, locDeleted: 1 },
      ],
    );
  });

  it("applies modify, add, and delete patches inside the worktree", () => {
    withWorktree((root) => {
      writeFileSync(join(root, "solution.py"), "def candidate(xs):\n    return None\n");
      writeFileSync(join(root, "old.txt"), "remove me\n");
      const patch = [
        "diff --git a/solution.py b/solution.py",
        "--- a/solution.py",
        "+++ b/solution.py",
        "@@ -1,2 +1,2 @@",
        " def candidate(xs):",
        "-    return None",
        "+    return xs[0]",
        "diff --git a/new.txt b/new.txt",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/new.txt",
        "@@ -0,0 +1,1 @@",
        "+created",
        "diff --git a/old.txt b/old.txt",
        "deleted file mode 100644",
        "--- a/old.txt",
        "+++ /dev/null",
        "@@ -1,1 +0,0 @@",
        "-remove me",
        "",
      ].join("\n");

      applyUnifiedDiff(root, patch);

      assert.equal(readFileSync(join(root, "solution.py"), "utf8"), "def candidate(xs):\n    return xs[0]\n");
      assert.equal(readFileSync(join(root, "new.txt"), "utf8"), "created\n");
      assert.equal(existsSync(join(root, "old.txt")), false);
    });
  });
  it("applies valid zero-count insertion and deletion hunks away from file boundaries", () => {
    withWorktree((root) => {
      writeFileSync(join(root, "solution.py"), "first\nsecond\nthird\n");
      const patch = [
        "diff --git a/solution.py b/solution.py",
        "--- a/solution.py",
        "+++ b/solution.py",
        "@@ -1,0 +2,1 @@",
        "+inserted",
        "@@ -3,1 +3,0 @@",
        "-third",
        "",
      ].join("\n");

      applyUnifiedDiff(root, patch);

      assert.equal(readFileSync(join(root, "solution.py"), "utf8"), "first\ninserted\nsecond\n");
    });
  });
  it("applies patches for canonical targets under top-level a and b directories", () => {
    withWorktree((root) => {
      mkdirSync(join(root, "b"));
      writeFileSync(join(root, "b", "solution.py"), "old\n");
      const patch = [
        "diff --git a/b/solution.py b/b/solution.py",
        "--- a/b/solution.py",
        "+++ b/b/solution.py",
        "@@ -1,1 +1,1 @@",
        "-old",
        "+new",
        "",
      ].join("\n");

      applyUnifiedDiff(root, patch);

      assert.equal(readFileSync(join(root, "b", "solution.py"), "utf8"), "new\n");
    });
  });

  it("rejects duplicate targets and worktree escapes", () => {
    const duplicatePatch = [
      "diff --git a/solution.py b/solution.py",
      "--- a/solution.py",
      "+++ b/solution.py",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "diff --git a/solution.py b/solution.py",
      "--- a/solution.py",
      "+++ b/solution.py",
      "@@ -1,1 +1,1 @@",
      "-new",
      "+newer",
      "",
    ].join("\n");
    assertPatchIssue(() => parseUnifiedDiff(duplicatePatch), "patch.target.duplicate");

    withWorktree((root) => {
      const traversalPatch = [
        "diff --git a/../../outside.txt b/../../outside.txt",
        "--- a/../../outside.txt",
        "+++ b/../../outside.txt",
        "@@ -1,1 +1,1 @@",
        "-old",
        "+new",
        "",
      ].join("\n");
      assertPatchIssue(() => applyUnifiedDiff(root, traversalPatch), "patch.target.invalid");
      const aliasPatch = [
        "diff --git a/sub/../solution.py b/sub/../solution.py",
        "--- a/sub/../solution.py",
        "+++ b/sub/../solution.py",
        "@@ -1,1 +1,1 @@",
        "-old",
        "+new",
        "",
      ].join("\n");
      assertPatchIssue(() => parseUnifiedDiff(aliasPatch), "patch.target.invalid");

      const parentChildPatch = [
        "diff --git a/dir b/dir",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/dir",
        "@@ -0,0 +1,1 @@",
        "+file body",
        "diff --git a/dir/file.py b/dir/file.py",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/dir/file.py",
        "@@ -0,0 +1,1 @@",
        "+nested",
        "",
      ].join("\n");
      assertPatchIssue(() => parseUnifiedDiff(parentChildPatch), "patch.target.conflict");

    });

    const renamePatch = [
      "diff --git a/old.py b/new.py",
      "--- a/old.py",
      "+++ b/new.py",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    assertPatchIssue(() => parseUnifiedDiff(renamePatch), "patch.renameUnsupported");

    const mismatchedHeaderPatch = [
      "diff --git a/solution.py b/solution.py",
      "--- a/other.py",
      "+++ b/solution.py",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    assertPatchIssue(() => parseUnifiedDiff(mismatchedHeaderPatch), "patch.target.mismatch");

    const mismatchedAddDiffPatch = [
      "diff --git a/old.py b/new.py",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.py",
      "@@ -0,0 +1,1 @@",
      "+new",
      "",
    ].join("\n");
    assertPatchIssue(() => parseUnifiedDiff(mismatchedAddDiffPatch), "patch.renameUnsupported");

    const mismatchedDeleteDiffPatch = [
      "diff --git a/old.py b/new.py",
      "deleted file mode 100644",
      "--- a/old.py",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-old",
      "",
    ].join("\n");
    assertPatchIssue(() => parseUnifiedDiff(mismatchedDeleteDiffPatch), "patch.renameUnsupported");
  });

  it("rejects existing symlink targets and symlinked parent directories", () => {
    withWorktree((root) => {
      const outsideRoot = mkdtempSync(join(tmpdir(), "agentoj-outside-"));
      try {
        writeFileSync(join(outsideRoot, "outside.py"), "outside\n");
        symlinkSync(join(outsideRoot, "outside.py"), join(root, "link.py"));
        const targetSymlinkPatch = [
          "diff --git a/link.py b/link.py",
          "--- a/link.py",
          "+++ b/link.py",
          "@@ -1,1 +1,1 @@",
          "-outside",
          "+changed",
          "",
        ].join("\n");
        assertPatchIssue(() => applyUnifiedDiff(root, targetSymlinkPatch), "patch.target.symlink");
        assert.equal(readFileSync(join(outsideRoot, "outside.py"), "utf8"), "outside\n");

        mkdirSync(join(outsideRoot, "dir"));
        symlinkSync(join(outsideRoot, "dir"), join(root, "linkdir"));
        const parentSymlinkPatch = [
          "diff --git a/linkdir/new.py b/linkdir/new.py",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/linkdir/new.py",
          "@@ -0,0 +1,1 @@",
          "+created",
          "",
        ].join("\n");
        assertPatchIssue(() => applyUnifiedDiff(root, parentSymlinkPatch), "patch.target.symlink");
        assert.equal(existsSync(join(outsideRoot, "dir", "new.py")), false);
      } finally {
        rmSync(outsideRoot, { recursive: true, force: true });
      }
    });
  });
  it("rejects non-directory parent components before applying", () => {
    withWorktree((root) => {
      writeFileSync(join(root, "not-dir"), "plain file\n");
      const parentFilePatch = [
        "diff --git a/not-dir/new.py b/not-dir/new.py",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/not-dir/new.py",
        "@@ -0,0 +1,1 @@",
        "+created",
        "",
      ].join("\n");
      assertPatchIssue(() => applyUnifiedDiff(root, parentFilePatch), "patch.target.parent");
    });
  });

  it("rejects binary, symlink, malformed, and context-mismatched patches", () => {
    assertPatchIssue(
      () =>
        applyUnifiedDiff(
          "/tmp",
          [
            "diff --git a/image.png b/image.png",
            "Binary files a/image.png and b/image.png differ",
            "",
          ].join("\n"),
        ),
      "patch.binary",
    );

    assertPatchIssue(
      () =>
        applyUnifiedDiff(
          "/tmp",
          [
            "diff --git a/link b/link",
            "index 1111111..2222222 120000",
            "--- a/link",
            "+++ b/link",
            "@@ -1,1 +1,1 @@",
            "-old-target",
            "+new-target",
            "",
          ].join("\n"),
        ),
      "patch.symlink",
    );

    assertPatchIssue(
      () =>
        applyUnifiedDiff(
          "/tmp",
          [
            "diff --git a/link b/link",
            "new file mode 120000",
            "--- /dev/null",
            "+++ b/link",
            "@@ -0,0 +1,1 @@",
            "+target",
            "",
          ].join("\n"),
        ),
      "patch.symlink",
    );

    assertPatchIssue(
      () =>
        parseUnifiedDiff(
          [
            "diff --git a/link b/link",
            "new file mode 120000",
            "index 0000000..1111111 100644",
            "--- /dev/null",
            "+++ b/link",
            "@@ -0,0 +1,1 @@",
            "+target",
            "",
          ].join("\n"),
        ),
      "patch.modeConflict",
    );

    assertPatchIssue(
      () =>
        parseUnifiedDiff(
          [
            "diff --git a/file b/file",
            "new file mode 100644",
            "--- a/file",
            "+++ /dev/null",
            "@@ -1,1 +0,0 @@",
            "-old",
            "",
          ].join("\n"),
        ),
      "patch.target.mismatch",
    );

    assertPatchIssue(
      () =>
        parseUnifiedDiff(
          [
            "diff --git a/file b/file",
            "deleted file mode 100644",
            "--- /dev/null",
            "+++ b/file",
            "@@ -0,0 +1,1 @@",
            "+new",
            "",
          ].join("\n"),
        ),
      "patch.target.mismatch",
    );

    assertPatchIssue(
      () =>
        parseUnifiedDiff(
          [
            "diff --git a/file b/file",
            "new file mode not-a-mode",
            "--- /dev/null",
            "+++ b/file",
            "@@ -0,0 +1,1 @@",
            "+new",
            "",
          ].join("\n"),
        ),
      "patch.modeUnsupported",
    );
    assertPatchIssue(
      () =>
        parseUnifiedDiff(
          [
            "diff --git a/tool.py b/tool.py",
            "index 0000000..1111111 100755",
            "new file mode 100644",
            "--- /dev/null",
            "+++ b/tool.py",
            "@@ -0,0 +1,1 @@",
            "+print('tool')",
            "",
          ].join("\n"),
        ),
      "patch.modeConflict",
    );

    assertPatchIssue(() => parseUnifiedDiff("--- a/file\n+++ b/file\n@@ -1,1 +1,1 @@\n-old\n+new\n"), "patch.malformed");

    withWorktree((root) => {
      writeFileSync(join(root, "solution.py"), "--removed\n");
      const prefixContentPatch = [
        "diff --git a/solution.py b/solution.py",
        "--- a/solution.py",
        "+++ b/solution.py",
        "@@ -1,1 +1,1 @@",
        "---removed",
        "+++added",
        "",
      ].join("\n");
      applyUnifiedDiff(root, prefixContentPatch);
      assert.equal(readFileSync(join(root, "solution.py"), "utf8"), "++added\n");
    });

    assertPatchIssue(
      () =>
        parseUnifiedDiff(
          [
            "diff --git a/solution.py b/solution.py",
            "--- a/solution.py",
            "+++ b/solution.py",
            "@@ -1,1 +1,1 @@",
            " old",
            "\\ unexpected marker",
            "",
          ].join("\n"),
        ),
      "patch.hunk.malformed",
    );

    assertPatchIssue(
      () =>
        parseUnifiedDiff(
          [
            "diff --git a/solution.py b/solution.py",
            "--- a/solution.py",
            "+++ b/solution.py",
            "@@ -1,1 +1,1 @@",
            "-old",
            "+new",
            "\\ No newline at end of file",
            "",
          ].join("\n"),
        ),
      "patch.hunk.noNewlineUnsupported",
    );

    withWorktree((root) => {
      writeFileSync(join(root, "solution.py"), "actual\n");
      const mismatchPatch = [
        "diff --git a/solution.py b/solution.py",
        "--- a/solution.py",
        "+++ b/solution.py",
        "@@ -1,1 +1,1 @@",
        "-expected",
        "+new",
        "",
      ].join("\n");
      assertPatchIssue(() => applyUnifiedDiff(root, mismatchPatch), "patch.delete.mismatch");
    });
  });
  it("rejects missing file headers, hunk count mismatches, and unsupported mode changes", () => {
    assertPatchIssue(
      () =>
        parseUnifiedDiff(
          [
            "diff --git a/solution.py b/solution.py",
            "@@ -1,1 +1,1 @@",
            "-old",
            "+new",
            "",
          ].join("\n"),
        ),
      "patch.header.missing",
    );

    assertPatchIssue(
      () =>
        parseUnifiedDiff(
          [
            "diff --git a/solution.py b/solution.py",
            "--- a/solution.py",
            "+++ b/solution.py",
            "@@ -x,1 +1,1 @@",
            "-old",
            "+new",
            "",
          ].join("\n"),
        ),
      "patch.hunk.malformed",
    );
    assertPatchIssue(
      () =>
        parseUnifiedDiff(
          [
            "diff --git a/solution.py b/solution.py",
            "--- a/solution.py",
            "+++ b/solution.py",
            "@@ -1,1 +1,1 @@trailing",
            "-old",
            "+new",
            "",
          ].join("\n"),
        ),
      "patch.hunk.malformed",
    );

    assertPatchIssue(
      () =>
        parseUnifiedDiff(
          [
            "diff --git a/solution.py b/solution.py",
            "--- a/solution.py",
            "+++ b/solution.py",
            "@@ -0,0 +0,0 @@",
            "",
          ].join("\n"),
        ),
      "patch.hunk.empty",
    );

    const countMismatchPatch = [
      "diff --git a/solution.py b/solution.py",
      "--- a/solution.py",
      "+++ b/solution.py",
      "@@ -1,2 +1,1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    withWorktree((root) => {
      writeFileSync(join(root, "solution.py"), "old\n");
      assertPatchIssue(() => applyUnifiedDiff(root, countMismatchPatch), "patch.hunk.countMismatch");
    });
    assertPatchIssue(() => parseUnifiedDiff(countMismatchPatch), "patch.hunk.countMismatch");

    withWorktree((root) => {
      writeFileSync(join(root, "solution.py"), "old\n");
      const rangePatch = [
        "diff --git a/solution.py b/solution.py",
        "--- a/solution.py",
        "+++ b/solution.py",
        "@@ -999,0 +999,1 @@",
        "+ghost",
        "",
      ].join("\n");
      assertPatchIssue(() => applyUnifiedDiff(root, rangePatch), "patch.hunk.range");
    });

    withWorktree((root) => {
      writeFileSync(join(root, "solution.py"), "first\nsecond\n");
      const projectedPatch = [
        "diff --git a/solution.py b/solution.py",
        "--- a/solution.py",
        "+++ b/solution.py",
        "@@ -2,1 +99,1 @@",
        "-second",
        "+changed",
        "",
      ].join("\n");
      assertPatchIssue(() => applyUnifiedDiff(root, projectedPatch), "patch.hunk.range");
    });

    assertPatchIssue(
      () =>
        parseUnifiedDiff(
          [
            "diff --git a/solution.py b/solution.py",
            "--- a/solution.py",
            "+++ b/solution.py",
            "@@ -1,1 +0,1 @@",
            "-old",
            "+new",
            "",
          ].join("\n"),
        ),
      "patch.hunk.range",
    );

    withWorktree((root) => {
      writeFileSync(join(root, "script.py"), "print('ok')\n");
      const modePatch = [
        "diff --git a/script.py b/script.py",
        "old mode 100644",
        "new mode 100755",
        "--- a/script.py",
        "+++ b/script.py",
        "@@ -1,1 +1,1 @@",
        "-print('ok')",
        "+print('still ok')",
        "",
      ].join("\n");
      assertPatchIssue(() => applyUnifiedDiff(root, modePatch), "patch.modeChange");
    });

    withWorktree((root) => {
      const executableAddPatch = [
        "diff --git a/tool.py b/tool.py",
        "new file mode 100755",
        "--- /dev/null",
        "+++ b/tool.py",
        "@@ -0,0 +1,1 @@",
        "+print('tool')",
        "",
      ].join("\n");
      assertPatchIssue(() => applyUnifiedDiff(root, executableAddPatch), "patch.modeUnsupported");
    });
  });

  it("leaves the worktree unchanged when a later file in a multi-file patch is invalid", () => {
    withWorktree((root) => {
      writeFileSync(join(root, "solution.py"), "old\n");
      const patch = [
        "diff --git a/solution.py b/solution.py",
        "--- a/solution.py",
        "+++ b/solution.py",
        "@@ -1,1 +1,1 @@",
        "-old",
        "+new",
        "diff --git a/link b/link",
        "new file mode 120000",
        "--- /dev/null",
        "+++ b/link",
        "@@ -0,0 +1,1 @@",
        "+target",
        "",
      ].join("\n");

      assertPatchIssue(() => applyUnifiedDiff(root, patch), "patch.symlink");
      assert.equal(readFileSync(join(root, "solution.py"), "utf8"), "old\n");
      assert.equal(existsSync(join(root, "link")), false);
    });
  });
});
