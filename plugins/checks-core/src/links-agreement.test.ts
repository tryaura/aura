import type { ResolvedSharedLink } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { app, document, onlyFinding, READY, workspace } from "./testing.js";
import { sharedInstructionLinksCheck } from "./instructions.js";

/**
 * What INS-002 reports and what its `fix` would do have to agree.
 *
 * Every shape here is one where they once disagreed, and each disagreement reads the same way from
 * the terminal: an error the report offers `--fix` for, a fix that writes nothing, and the same
 * error again on the next run.
 */
describe("INS-002 detection and planning agree", () => {
  it("accepts a link the planner sees on disk but the adapter did not parse", () => {
    // A native copy already holding exactly the declared content, written by an adapter whose own
    // parser surfaces no link for it. The file is what decides: the planner read it and had
    // nothing left to write.
    const path = "/home/dev/.native/AGENTS.md";
    const content = "SHARED: /home/dev/agents/AGENTS.md\n";
    const link: ResolvedSharedLink = {
      content,
      entryPath: path,
      kind: "native-copy",
      scope: "global",
    };
    const application = app({
      instructionFiles: [document(path, content)],
      link,
      source: { exists: true, pathKind: "file" },
    });

    expect(sharedInstructionLinksCheck.detect(workspace([application], "# Shared\n"))).toEqual([]);
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
});
