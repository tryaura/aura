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
        left: expect.objectContaining({ line: 1, path: "/workspace/AGENTS.md" }),
        right: expect.objectContaining({ line: 1, path: "/workspace/CLAUDE.md" }),
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

  it.each([
    ["indentation", "Do not use tabs for indentation.", "Use spaces for indentation."],
    ["package manager", "Never use npm for dependencies.", "Always use pnpm for dependencies."],
    ["commit style", "Do not use conventional commits.", "Prefer free-form commit messages."],
    ["emoji policy", "Do not use emojis in responses.", "Avoid emojis in responses."],
  ])("does not double-match negated %s guidance", (_axis, left, right) => {
    expect(
      run([document("/workspace/AGENTS.md", left), document("/workspace/CLAUDE.md", right)]),
    ).toEqual([]);
  });

  it.each([
    ["a word between the negator and the rule", "Do not always use tabs for indentation."],
    ["an adverb after the negator", "Do not ever use npm for dependencies."],
    ["a doubled negator", "Never ever use npm for dependencies."],
    ["a negator outside the fixed openings", "We should not use tabs for indentation."],
    ["a contraction", "We don't ever use npm for dependencies."],
  ])("reads %s as a prohibition rather than an endorsement", (_case, prohibition) => {
    expect(
      run([
        document("/workspace/AGENTS.md", prohibition),
        document("/workspace/CLAUDE.md", "Always use pnpm and 2 spaces for indentation."),
      ]),
    ).toEqual([]);
  });

  it("surfaces content-free polarities in details and metadata", () => {
    const findings = run([
      document("/workspace/AGENTS.md", "Always use tabs for indentation."),
      document("/workspace/CLAUDE.md", "Always use 2 spaces for indentation."),
    ]);

    expect(findings[0]?.details).toBe(
      "Locations: AGENTS.md:1 says tabs; CLAUDE.md:1 says 2 spaces.",
    );
    expect(findings[0]?.metadata).toMatchObject({
      left: { polarity: "tabs" },
      right: { polarity: "spaces:2" },
    });
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
