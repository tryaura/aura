import { describe, expect, it } from "vitest";

import type { GitignoreModel } from "@tryaura/aura-sdk";

import { env003 } from "./env-003.js";
import { requireFinding } from "./testing.js";
import { gitignore, projectModel } from "./testing-repository.js";

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
  });

  it("accepts a personal rule that lives in info/exclude instead of the shared file", () => {
    const shared = gitignore("!/AGENTS.md\n!/CLAUDE.md\n!/.mcp.json\n");
    const local = gitignore("/.claude/settings.local.json\n", true, "/repo/.git/info/exclude");

    expect(env003.detect(projectModel(shared, { infoExclude: local }))).toEqual([]);
    expect(env003.detect(projectModel(shared))).toHaveLength(1);
  });

  it("gives root .gitignore precedence over info/exclude and reports manual repair", () => {
    const local = gitignore("/AGENTS.md\n", true, "/repo/.git/info/exclude");
    const completeShared = gitignore(
      "/.claude/settings.local.json\n!/AGENTS.md\n!/CLAUDE.md\n!/.mcp.json\n",
    );
    expect(env003.detect(projectModel(completeShared, { infoExclude: local }))).toEqual([]);

    const incompleteShared = gitignore("/.claude/settings.local.json\n!/CLAUDE.md\n!/.mcp.json\n");
    const detected = env003.detect(projectModel(incompleteShared, { infoExclude: local }))[0];
    expect(requireFinding(detected, "ENV-003", "project", "warn")).toBeDefined();
    expect(env003.fixability).toBe("manual");
  });

  it("lets root .gitignore override a negation from info/exclude", () => {
    const shared = gitignore(
      "/.claude/settings.local.json\n/AGENTS.md\n!/CLAUDE.md\n!/.mcp.json\n",
    );
    const local = gitignore("!/AGENTS.md\n", true, "/repo/.git/info/exclude");

    expect(env003.detect(projectModel(shared, { infoExclude: local }))[0]).toMatchObject({
      id: "gitignore-policy",
      metadata: { shareableIgnored: ["AGENTS.md"] },
    });
  });

  it("matches ignore patterns case-sensitively", () => {
    const content =
      "agents.md\n/.claude/settings.local.json\n!/AGENTS.md\n!/CLAUDE.md\n!/.mcp.json\n";

    expect(env003.detect(projectModel(gitignore(content)))).toEqual([]);
  });

  it("reports an unreadable info/exclude without inferring policy state", () => {
    const local: GitignoreModel = {
      exists: true,
      path: "/repo/.git/info/exclude",
      patterns: [],
      problem: "denied",
    };

    expect(env003.detect(projectModel(gitignore(""), { infoExclude: local }))).toEqual([
      {
        details:
          "Aura could not read /repo/.git/info/exclude: denied. Ignore-policy findings are omitted because the effective Git rules are unknown.",
        fixability: "manual",
        id: "info-exclude-unreadable",
        locations: [{ path: "/repo/.git/info/exclude" }],
        message: "The repository-local Git exclude file could not be inspected.",
      },
    ]);
  });

  it("reports ignored personal paths already tracked without running Git", () => {
    const content = "/.claude/settings.local.json\n!/AGENTS.md\n!/CLAUDE.md\n!/.mcp.json\n";
    const findings = env003.detect(
      projectModel(gitignore(content), {
        trackedAgentPaths: [".claude/settings.local.json", "AGENTS.md"],
      }),
    );

    expect(findings.map((finding) => finding.id)).toEqual([
      "tracked-personal-path:.claude/settings.local.json",
    ]);
    expect(findings[0]?.severity).toBe("info");
    expect(findings[0]?.details).toContain("git rm --cached -- .claude/settings.local.json");
  });

  it("reports a tracked personal path before it is ignored", () => {
    const findings = env003.detect(
      projectModel(gitignore("!/AGENTS.md\n!/CLAUDE.md\n!/.mcp.json\n"), {
        trackedAgentPaths: [".claude/settings.local.json"],
      }),
    );

    expect(findings.map((finding) => finding.id)).toEqual([
      "gitignore-policy",
      "tracked-personal-path:.claude/settings.local.json",
    ]);
    expect(findings[1]?.message).toBe(
      ".claude/settings.local.json is already tracked by Git but should remain personal.",
    );
  });

  it("leaves a missing gitignore for manual repair", () => {
    const workspace = projectModel(gitignore("", false));
    const detected = env003.detect(workspace)[0];
    expect(requireFinding(detected, "ENV-003", "project", "warn")).toBeDefined();
    expect(env003.fixability).toBe("manual");
  });

  it("reports a complete managed block an earlier release left behind", () => {
    const content =
      "node_modules/\n# aura:begin ENV-003\n/.claude/settings.local.json\n/.claude/skills/\n!/AGENTS.md\n!/CLAUDE.md\n!/.mcp.json\n# aura:end ENV-003\n";
    const finding = env003
      .detect(projectModel(gitignore(content)))
      .find((candidate) => candidate.id === "managed-block-abandoned");

    expect(finding?.fixability).toBe("manual");
    expect(finding?.severity).toBe("info");
    expect(finding?.details).toContain("no longer maintains it");
    expect(finding?.details).toContain("/repo/.claude/skills");
  });

  it("reports a half-removed block, because finishing the removal is still someone's job", () => {
    const finding = env003
      .detect(projectModel(gitignore("# aura:begin ENV-003\n/.claude/settings.local.json\n")))
      .find((candidate) => candidate.id === "managed-block-abandoned");

    expect(finding?.details).toContain("without the other");
  });

  it("says nothing about a managed block in a file that never had one", () => {
    const content = "/.claude/settings.local.json\n!/AGENTS.md\n!/CLAUDE.md\n!/.mcp.json\n";

    expect(
      env003
        .detect(projectModel(gitignore(content)))
        .some((candidate) => candidate.id === "managed-block-abandoned"),
    ).toBe(false);
  });

  it("reports an unreadable gitignore without offering a fix", () => {
    const workspace = projectModel({
      exists: true,
      path: "/repo/.gitignore",
      patterns: [],
      problem: "denied",
    });
    const detected = env003.detect(workspace)[0];
    expect(detected?.id).toBe("gitignore-unreadable");
    expect(detected?.fixability).toBe("manual");
  });
});
