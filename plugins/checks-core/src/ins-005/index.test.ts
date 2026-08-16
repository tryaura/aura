import type { InstructionDocument } from "@tryaura/aura-sdk";
import { runChecks } from "@tryaura/core";
import { describe, expect, it } from "vitest";

import checksCore from "../index.js";
import { document, model } from "../testing.js";
import { contradictoryInstructionsCheck } from "./index.js";

describe("INS-005", () => {
  it("is registered as a report-only informational check", () => {
    expect(checksCore.checks).toContain(contradictoryInstructionsCheck);
    expect(contradictoryInstructionsCheck).toMatchObject({
      defaultSeverity: "info",
      fixability: "manual",
      id: "INS-005",
      scope: "global",
    });
  });

  it.each([
    ["indentation", "Always use tabs for indentation.", "Always use 2 spaces for indentation."],
    ["indentation", "Use 2 spaces for indentation.", "Use 4 spaces for indentation."],
    ["package-manager", "Always use pnpm for dependencies.", "Only use npm for dependencies."],
    ["semicolons", "Always use semicolons.", "Never use semicolons."],
    ["commit-style", "Use conventional commits.", "Prefer free-form commit messages."],
    ["emoji-policy", "Include emojis in responses.", "Do not use emojis in responses."],
    ["line-width", "Maximum line width is 100.", "Maximum line width is 120."],
    ["response-detail", "Keep responses concise.", "Provide detailed explanations."],
  ])("reports conflicting %s guidance", (axis, left, right) => {
    const findings = run([
      document("/workspace/AGENTS.md", left),
      document("/workspace/CLAUDE.md", right),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      checkId: "INS-005",
      locations: [
        { line: 1, path: "/workspace/AGENTS.md" },
        { line: 1, path: "/workspace/CLAUDE.md" },
      ],
      metadata: {
        axis,
        left: { line: 1, path: "/workspace/AGENTS.md" },
        right: { line: 1, path: "/workspace/CLAUDE.md" },
      },
      severity: "info",
    });
    expect(JSON.stringify(findings)).not.toContain(left);
    expect(JSON.stringify(findings)).not.toContain(right);
  });

  it.each([
    ["indentation", "Use spaces for indentation.", "Use 2 spaces for indentation."],
    ["package manager", "The project currently contains pnpm files.", "Use npm for dependencies."],
    ["semicolons", "Semicolons are part of JavaScript syntax.", "Never use semicolons."],
    [
      "commit style",
      "Conventional commits are documented below.",
      "Prefer free-form commit messages.",
    ],
    ["emoji", "An emoji can improve a heading.", "Do not use emojis in responses."],
    ["line width", "The terminal reports a line width.", "Maximum line width is 120."],
    ["response detail", "The concise guide is linked here.", "Provide detailed explanations."],
  ])("ignores a near-miss %s mention", (_axis, left, right) => {
    expect(
      run([document("/workspace/AGENTS.md", left), document("/workspace/CLAUDE.md", right)]),
    ).toEqual([]);
  });

  it("ignores guidance inside inline and fenced code", () => {
    const masked = [
      "`Always use tabs for indentation.`",
      "",
      "```md",
      "Always use pnpm for dependencies.",
      "```",
    ].join("\n");
    const visible = ["Always use 2 spaces for indentation.", "Only use npm for dependencies."].join(
      "\n",
    );

    expect(
      run([document("/workspace/AGENTS.md", masked), document("/workspace/CLAUDE.md", visible)]),
    ).toEqual([]);
  });

  it.each([
    ["indentation", "Always use tabs for indentation.", "Always use 2 spaces for indentation."],
    ["package-manager", "Always use pnpm for dependencies.", "Only use npm for dependencies."],
    ["semicolons", "Always use semicolons.", "Never use semicolons."],
    ["commit-style", "Use conventional commits.", "Prefer free-form commit messages."],
    ["emoji-policy", "Include emojis in responses.", "Do not use emojis in responses."],
    ["line-width", "Maximum line width is 100.", "Maximum line width is 120."],
    ["response-detail", "Keep responses concise.", "Provide detailed explanations."],
  ])("masks inline-code evidence for %s", (_axis, masked, visible) => {
    expect(
      run([
        document("/workspace/AGENTS.md", `\`${masked}\``),
        document("/workspace/CLAUDE.md", visible),
      ]),
    ).toEqual([]);
  });

  it("leaves conflicts that cross the global and project tiers to INS-008", () => {
    expect(
      run([
        document("/home/dev/AGENTS.md", "Always use tabs for indentation."),
        document("/workspace/AGENTS.md", "Always use 2 spaces for indentation.", {
          scope: "project",
        }),
      ]),
    ).toEqual([]);
  });

  it("requires different files and different polarities", () => {
    expect(
      run([
        document(
          "/workspace/AGENTS.md",
          "Always use tabs for indentation.\nAlways use 2 spaces for indentation.",
        ),
      ]),
    ).toEqual([]);
    expect(
      run([
        document("/workspace/AGENTS.md", "Always use pnpm for dependencies."),
        document("/workspace/CLAUDE.md", "Prefer pnpm for dependencies."),
      ]),
    ).toEqual([]);
  });

  it("keeps output stable across input order, duplicate paths, and sentence edits", () => {
    const tabs = document("/workspace/AGENTS.md", "Always use tabs for indentation.");
    const spaces = document("/workspace/CLAUDE.md", "Always use 2 spaces for indentation.");
    const first = run([tabs, spaces, { ...tabs, sourceId: "other-adapter" }]);
    const reordered = run([spaces, tabs]);
    const edited = run([
      { ...tabs, content: "Prefer tabs for indentation." },
      { ...spaces, content: "Prefer 2 spaces for indentation." },
    ]);

    expect(first).toEqual(reordered);
    expect(first[0]?.id).toBe(edited[0]?.id);
  });
});

function run(instructionFiles: readonly InstructionDocument[]) {
  return runChecks([contradictoryInstructionsCheck], model({ instructionFiles })).findings;
}
