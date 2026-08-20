import type { InstructionDocument, ResolvedSharedLink } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import {
  app,
  document,
  linkedDocument,
  onlyFinding,
  READY,
  SHARED_PATH,
  workspace,
} from "./testing.js";
import { sharedInstructionLinksCheck } from "./instructions.js";

describe("INS-002", () => {
  it("passes when the parsed entry has a valid link to the shared source", () => {
    const application = app({
      instructionFiles: [linkedDocument("/home/dev/.codex/AGENTS.md", true)],
      link: { entryPath: "/home/dev/.codex/AGENTS.md", kind: "symlink", scope: "global" },
    });

    expect(sharedInstructionLinksCheck.detect(workspace([application], "# Shared\n"))).toEqual([]);
  });

  it("leaves a missing shared target to the checks that own target validity", () => {
    const application = app({
      instructionFiles: [linkedDocument("/home/dev/.codex/AGENTS.md", false)],
      link: { entryPath: "/home/dev/.codex/AGENTS.md", kind: "symlink", scope: "global" },
      source: { exists: true, pathKind: "symlink", symlinkTarget: SHARED_PATH },
    });

    expect(sharedInstructionLinksCheck.detect(workspace([application], undefined))).toEqual([]);
  });

  it.each([
    {
      document: importedDocument("/repo/CLAUDE.md", "project"),
      name: "a project-scoped document",
    },
    {
      document: importedDocument("/home/dev/.claude/PROJECT.md", "global"),
      name: "an alternate global document",
    },
  ])("does not accept a shared link from $name", ({ document }) => {
    const entryPath = "/home/dev/.claude/CLAUDE.md";
    const application = app({
      adapterId: "claude-code",
      instructionFiles: [document],
      link: { content: `@${SHARED_PATH}`, entryPath, kind: "import-line", scope: "global" },
    });

    expect(sharedInstructionLinksCheck.detect(workspace([application], "# Shared\n"))).toEqual([
      expect.objectContaining({ locations: [{ path: entryPath }] }),
    ]);
  });

  it("creates or corrects an absent or broken Codex symlink", () => {
    const absent = app({
      link: { entryPath: "/home/dev/.codex/AGENTS.md", kind: "symlink", scope: "global" },
    });
    const broken = app({
      instructionFiles: [
        {
          ...linkedDocument("/home/dev/.codex/AGENTS.md", false),
          links: [{ kind: "symlink", targetPath: "/wrong/AGENTS.md", valid: false }],
        },
      ],
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

  it("creates an absent native-copy wrapper but preserves changed content", () => {
    const link: ResolvedSharedLink = {
      content: "---\nalwaysApply: true\n---\n\n@file /home/dev/agents/AGENTS.md\n",
      entryPath: "/workspace/.cursor/rules/aura.mdc",
      kind: "native-copy",
      scope: "project",
    };
    const absentModel = workspace([app({ adapterId: "native-copy-app", link })], "# Shared\n");
    const changedModel = workspace(
      [
        app({
          adapterId: "native-copy-app",
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

  it("preserves malformed legacy markers while appending the plain import", () => {
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

    expect(finding.details).toBe(READY);
    expect(sharedInstructionLinksCheck.fix(finding, model)?.operations).toEqual([
      {
        content: "handwritten\n<!-- aura:begin -->\n\n@~/agents/AGENTS.md\n",
        mode: 0o644,
        path,
        type: "write",
      },
    ]);
  });

  it("says nothing about an application with no global instruction file", () => {
    // Cursor's shape: its global guidance lives in its own settings, so the adapter declares no
    // link. Reporting it would be an error whose only remedy is writing a file into whichever
    // repository the user ran `check` from — which is what this check used to ask for.
    const application = app({ adapterId: "cursor", displayName: "Cursor" });

    expect(sharedInstructionLinksCheck.detect(workspace([application], "# Shared\n"))).toEqual([]);
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
      // Report-only has to be visible in the finding too, or the report offers a `--fix` that
      // cannot run.
      expect(finding.fixability).toBe("manual");
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

function importedDocument(path: string, scope: InstructionDocument["scope"]): InstructionDocument {
  return {
    ...document(path, `@${SHARED_PATH}\n`, { scope }),
    links: [{ kind: "import", targetPath: SHARED_PATH, valid: true }],
  };
}
