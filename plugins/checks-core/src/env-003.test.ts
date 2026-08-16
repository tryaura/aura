import { describe, expect, it } from "vitest";

import { env003 } from "./env-003.js";
import { reconcileGitignoreBlock } from "./gitignore-block.js";
import { gitignore, projectModel, requireFinding } from "./testing.js";

describe("ENV-003", () => {
  it("passes a semantic policy with broad rules and final shareable negations", () => {
    const content = "*\n!*/\n!/.mcp.json\n!/AGENTS.md\n!/CLAUDE.md\n";

    expect(env003.detect(projectModel(gitignore(content)))).toEqual([]);
  });

  it("warns for an unignored personal path and an ignored shareable file", () => {
    const findings = env003.detect(projectModel(gitignore("AGENTS.md\n")));

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      id: "gitignore-policy",
      metadata: {
        personalNotIgnored: [".claude/settings.local.json"],
        shareableIgnored: ["AGENTS.md"],
      },
    });
  });

  it("names only paths the developer can go and look at", () => {
    const detail = env003.detect(projectModel(gitignore("")))[0]?.details ?? "";

    expect(detail).toBe("Personal paths not ignored: .claude/settings.local.json.");
    expect(detail).not.toContain(".aura-");
    expect(detail).not.toContain(".bak");
  });

  it("does not police backup files it has no reason to own", () => {
    const content = "/.claude/settings.local.json\n!/AGENTS.md\n!/CLAUDE.md\n!/.mcp.json\n";

    expect(env003.detect(projectModel(gitignore(content)))).toEqual([]);
    expect(reconcileGitignoreBlock("")).not.toContain(".bak");
  });

  it("accepts a personal rule that lives in info/exclude instead of the shared file", () => {
    const shared = gitignore("!/AGENTS.md\n!/CLAUDE.md\n!/.mcp.json\n");
    const local = gitignore("/.claude/settings.local.json\n", true, "/repo/.git/info/exclude");

    expect(env003.detect(projectModel(shared, { infoExclude: local }))).toEqual([]);
    expect(env003.detect(projectModel(shared))).toHaveLength(1);
  });

  it("reports ignored personal paths already tracked without running Git", () => {
    const content = "/.claude/settings.local.json\n!/AGENTS.md\n!/CLAUDE.md\n!/.mcp.json\n";
    const findings = env003.detect(
      projectModel(gitignore(content), {
        trackedAgentPaths: [".claude/settings.local.json", "AGENTS.md"],
      }),
    );

    expect(findings.map((finding) => finding.id)).toEqual([
      "ignored-but-tracked:.claude/settings.local.json",
    ]);
    expect(findings[0]?.severity).toBe("info");
    expect(findings[0]?.details).toContain("git rm --cached -- .claude/settings.local.json");
  });

  it("fixes a missing gitignore with one write operation", () => {
    const workspace = projectModel(gitignore("", false));
    const detected = env003.detect(workspace)[0];
    const finding = requireFinding(detected, "ENV-003", "project", "warn");
    const plan = env003.fix(finding, workspace);

    expect(plan).toEqual({
      operations: [
        {
          content:
            "# aura:begin ENV-003\n" +
            "# Managed by Aura. Personal agent state stays local; team configuration stays shareable.\n" +
            "/.claude/settings.local.json\n" +
            "!/AGENTS.md\n" +
            "!/CLAUDE.md\n" +
            "!/.mcp.json\n" +
            "# aura:end ENV-003\n",
          path: "/repo/.gitignore",
          type: "write",
        },
      ],
      summary: "Update Aura's managed agent-file rules in .gitignore.",
    });
  });

  it("preserves unrelated bytes and CRLF, moves the managed block last, and converges", () => {
    const original =
      "# keep\r\nnode_modules/\r\n# aura:begin ENV-003\r\nold-rule\r\n# aura:end ENV-003\r\n/dist\r\n";
    const once = reconcileGitignoreBlock(original);
    if (once === undefined) {
      throw new Error("expected valid managed block");
    }
    const twice = reconcileGitignoreBlock(once);

    expect(once).toContain("# keep\r\nnode_modules/\r\n/dist\r\n");
    expect(once.endsWith("# aura:end ENV-003\r\n")).toBe(true);
    expect(once.replaceAll("\r\n", "")).not.toContain("\n");
    expect(twice).toBe(once);
  });

  it("follows the document's first line ending rather than any CRLF anywhere in it", () => {
    const mostlyLf = reconcileGitignoreBlock("node_modules/\ndist/\r\ncoverage/\n");

    expect(mostlyLf?.endsWith("# aura:end ENV-003\n")).toBe(true);
    expect(mostlyLf).not.toContain("settings.local.json\r\n");
  });

  it.each([
    ["duplicate begin", "# aura:begin ENV-003\n# aura:begin ENV-003\n# aura:end ENV-003\n"],
    ["missing end", "# aura:begin ENV-003\n"],
    ["reversed markers", "# aura:end ENV-003\n# aura:begin ENV-003\n"],
    ["marker suffix", "# aura:begin ENV-003 old\n# aura:end ENV-003\n"],
    ["indented marker", " # aura:begin ENV-003\n# aura:end ENV-003\n"],
  ])("fails closed for %s markers", (_case, content) => {
    const workspace = projectModel(gitignore(content));
    const detected = env003.detect(workspace)[0];
    const finding = requireFinding(detected, "ENV-003", "project", "warn");

    expect(env003.fix(finding, workspace)).toBeUndefined();
  });

  it("reports an unreadable gitignore without offering a fix", () => {
    const workspace = projectModel({
      exists: true,
      path: "/repo/.gitignore",
      patterns: [],
      problem: "denied",
    });
    const detected = env003.detect(workspace)[0];
    const finding = requireFinding(detected, "ENV-003", "project", "warn");

    expect(detected?.id).toBe("gitignore-unreadable");
    expect(env003.fix(finding, workspace)).toBeUndefined();
  });
});
