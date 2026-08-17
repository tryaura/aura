import type { ResolvedSharedLink } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { app, linkedDocument, onlyFinding, READY, SHARED_PATH, workspace } from "./testing.js";
import { sharedInstructionLinksCheck } from "./instructions.js";

describe("INS-002", () => {
  it("passes when the parsed entry has a valid link to the shared source", () => {
    const application = app({
      instructionFiles: [linkedDocument("/home/dev/.codex/AGENTS.md", true)],
      link: { entryPath: "/home/dev/.codex/AGENTS.md", kind: "symlink", scope: "global" },
    });

    expect(sharedInstructionLinksCheck.detect(workspace([application], "# Shared\n"))).toEqual([]);
  });

  it("creates or corrects an absent or broken Codex symlink", () => {
    const absent = app({
      link: { entryPath: "/home/dev/.codex/AGENTS.md", kind: "symlink", scope: "global" },
    });
    const broken = app({
      instructionFiles: [linkedDocument("/home/dev/.codex/AGENTS.md", false)],
      link: { entryPath: "/home/dev/.codex/AGENTS.md", kind: "symlink", scope: "global" },
      source: { exists: true, pathKind: "symlink", symlinkTarget: "/wrong/AGENTS.md" },
    });

    for (const application of [absent, broken]) {
      const model = workspace([application], "# Shared\n");
      const finding = onlyFinding(sharedInstructionLinksCheck, model);
      expect(sharedInstructionLinksCheck.fix(finding, model)?.operations).toEqual([
        {
          path: "/home/dev/.codex/AGENTS.md",
          target: SHARED_PATH,
          type: "symlink",
        },
      ]);
    }
  });

  it("preserves a real Codex file and gives consolidation guidance", () => {
    const model = workspace(
      [
        app({
          link: { entryPath: "/home/dev/.codex/AGENTS.md", kind: "symlink", scope: "global" },
          source: { exists: true, pathKind: "file" },
        }),
      ],
      "# Shared\n",
    );
    const finding = onlyFinding(sharedInstructionLinksCheck, model);

    expect(finding.details).toContain("Consolidate its content");
    expect(sharedInstructionLinksCheck.fix(finding, model)).toBeUndefined();
  });

  it("creates an absent Cursor wrapper but preserves changed content", () => {
    const link: ResolvedSharedLink = {
      content: "---\nalwaysApply: true\n---\n\n@file /home/dev/agents/AGENTS.md\n",
      entryPath: "/workspace/.cursor/rules/aura.mdc",
      kind: "native-copy",
      scope: "project",
    };
    const absentModel = workspace([app({ adapterId: "cursor", link })], "# Shared\n");
    const changedModel = workspace(
      [
        app({
          adapterId: "cursor",
          instructionFiles: [
            {
              ...linkedDocument(link.entryPath, false),
              content: "# My rule\n",
            },
          ],
          link,
          source: { exists: true, pathKind: "file" },
        }),
      ],
      "# Shared\n",
    );

    const absentFinding = onlyFinding(sharedInstructionLinksCheck, absentModel);
    expect(sharedInstructionLinksCheck.fix(absentFinding, absentModel)?.operations).toEqual([
      { content: link.content, mode: 0o644, path: link.entryPath, type: "write" },
    ]);
    const changedFinding = onlyFinding(sharedInstructionLinksCheck, changedModel);
    expect(changedFinding.details).toContain("user-owned and preserved");
    expect(sharedInstructionLinksCheck.fix(changedFinding, changedModel)).toBeUndefined();
  });

  it("preserves malformed Claude managed markers and says why", () => {
    const path = "/home/dev/.claude/CLAUDE.md";
    const model = workspace(
      [
        app({
          adapterId: "claude-code",
          instructionFiles: [
            {
              ...linkedDocument(path, false),
              content: "handwritten\n<!-- aura:begin -->\n",
            },
          ],
          link: {
            content: "@~/agents/AGENTS.md",
            entryPath: path,
            kind: "import-line",
            scope: "global",
          },
          source: { exists: true, pathKind: "file" },
        }),
      ],
      "# Shared\n",
    );
    const finding = onlyFinding(sharedInstructionLinksCheck, model);

    expect(finding.details).toContain("malformed");
    expect(finding.details).not.toContain(READY);
    expect(sharedInstructionLinksCheck.fix(finding, model)).toBeUndefined();
  });

  it("never promises a fix it cannot produce", () => {
    // A dangling symlink exists, carries no problem, and yields no parsed document — the one shape
    // that used to be reported as fixable while `fix` quietly returned nothing, run after run.
    const path = "/home/dev/.claude/CLAUDE.md";
    const model = workspace(
      [
        app({
          adapterId: "claude-code",
          link: {
            content: "@~/agents/AGENTS.md",
            entryPath: path,
            kind: "import-line",
            scope: "global",
          },
          source: { exists: true, pathKind: "symlink", symlinkTarget: "/gone.md" },
        }),
      ],
      "# Shared\n",
    );
    const finding = onlyFinding(sharedInstructionLinksCheck, model);

    expect(sharedInstructionLinksCheck.fix(finding, model)).toBeUndefined();
    expect(finding.details).toContain("broken symbolic link");
    expect(finding.details).not.toContain(READY);
  });

  it("tells the user to keep a project-scoped wrapper out of version control", () => {
    const link: ResolvedSharedLink = {
      content: "@file /home/dev/agents/AGENTS.md\n",
      entryPath: "/workspace/.cursor/rules/aura.mdc",
      kind: "native-copy",
      scope: "project",
    };
    const model = workspace([app({ adapterId: "cursor", link })], "# Shared\n");
    const finding = onlyFinding(sharedInstructionLinksCheck, model);

    expect(sharedInstructionLinksCheck.fix(finding, model)?.manualSteps).toEqual([
      `${link.entryPath} points at the shared source by absolute path, which is specific to this machine and this user. Keep it out of version control — add it to .gitignore or .git/info/exclude.`,
    ]);
  });

  it("leaves a global entry without a version-control warning", () => {
    const link: ResolvedSharedLink = {
      content: "@~/agents/AGENTS.md",
      entryPath: "/home/dev/.claude/CLAUDE.md",
      kind: "import-line",
      scope: "global",
    };
    const model = workspace([app({ adapterId: "claude-code", link })], "# Shared\n");
    const finding = onlyFinding(sharedInstructionLinksCheck, model);

    expect(sharedInstructionLinksCheck.fix(finding, model)?.manualSteps).toBeUndefined();
  });

  it("keeps unsupported versions and undeclared mechanisms report-only", () => {
    const unsupported = app({
      link: { entryPath: "/home/dev/.codex/AGENTS.md", kind: "symlink", scope: "global" },
      status: "unsupported",
    });
    const undeclared = app({ adapterId: "third-party" });

    for (const application of [unsupported, undeclared]) {
      const model = workspace([application], "# Shared\n");
      const finding = onlyFinding(sharedInstructionLinksCheck, model);
      expect(sharedInstructionLinksCheck.fix(finding, model)).toBeUndefined();
    }
  });

  it("does not accept an import as Codex's native symlink mechanism", () => {
    const path = "/home/dev/.codex/AGENTS.md";
    const application = app({
      adapterId: "codex",
      instructionFiles: [
        {
          content: `@${SHARED_PATH}\n`,
          links: [{ kind: "import", targetPath: SHARED_PATH, valid: true }],
          path,
          scope: "global",
          sourceId: "codex.instructions.global",
        },
      ],
      link: { entryPath: path, kind: "symlink", scope: "global" },
      source: { exists: true, pathKind: "file" },
    });

    expect(sharedInstructionLinksCheck.detect(workspace([application], "# Shared\n"))).toHaveLength(
      1,
    );
  });

  it("ignores any synthetic inventory adapter, not one named id", () => {
    const inventory = app({ adapterId: "legacy-instructions", synthetic: true });

    expect(sharedInstructionLinksCheck.detect(workspace([inventory], "# Shared\n"))).toEqual([]);
  });

  it("keeps problematic entries report-only", () => {
    const model = workspace(
      [
        app({
          link: { entryPath: "/home/dev/.codex/AGENTS.md", kind: "symlink", scope: "global" },
          source: { exists: true, problem: "denied" },
        }),
      ],
      "# Shared\n",
    );
    const finding = onlyFinding(sharedInstructionLinksCheck, model);

    expect(finding.details).toContain("denied");
    expect(sharedInstructionLinksCheck.fix(finding, model)).toBeUndefined();
  });
});
