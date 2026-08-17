import { isConditionalCursorRule } from "@tryaura/adapter-cursor";
import { describe, expect, it } from "vitest";

import { extractParagraphs, normalizeParagraph } from "./instruction-paragraphs.js";
import { document } from "./testing.js";

describe("instruction paragraph extraction", () => {
  it("normalizes case, whitespace, list markers, and trailing punctuation", () => {
    expect(normalizeParagraph(["  1.  ALWAYS   run tests", "- Before shipping!!!  "])).toBe(
      "always run tests before shipping",
    );
  });

  it("preserves inclusive line ranges across CRLF paragraphs", () => {
    const content = [
      "Short.",
      "",
      "Always run the complete verification suite before merging changes",
      "and investigate every failure before considering the work complete.",
      "",
      "Document surprising behavior so future maintainers understand the intended constraint.",
    ].join("\r\n");

    expect(extractParagraphs([document("/repo/AGENTS.md", content)])).toMatchObject([
      { endLine: 4, startLine: 3 },
      { endLine: 6, startLine: 6 },
    ]);
  });

  it("treats MDC rules as conditional unless alwaysApply is explicitly true", () => {
    expect(isConditionalCursorRule(document("/repo/rule.mdc", "guidance"))).toBe(true);
    expect(
      isConditionalCursorRule(
        document("/repo/rule.mdc", "guidance", { metadata: { alwaysApply: false } }),
      ),
    ).toBe(true);
    expect(
      isConditionalCursorRule(
        document("/repo/rule.mdc", "guidance", { metadata: { alwaysApply: true } }),
      ),
    ).toBe(false);
    expect(isConditionalCursorRule(document("/repo/AGENTS.md", "guidance"))).toBe(false);
  });

  it("masks fenced and inline code without emitting code-only paragraphs", () => {
    const content = [
      "```ts",
      "const privateImplementation = 'must never become guidance';",
      "```",
      "",
      "Always run `pnpm verify` before merging because the complete suite protects every package.",
    ].join("\n");

    const paragraphs = extractParagraphs([document("/repo/CLAUDE.md", content)]);

    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]?.startLine).toBe(5);
    expect(paragraphs[0]?.normalized).not.toContain("pnpm verify");
    expect(paragraphs[0]?.normalized).not.toContain("privateimplementation");
  });

  it("keeps masked code out of the prose but recoverable for comparison", () => {
    const [lint, publish] = [
      "Always run `pnpm lint` before pushing so that every package stays reviewable.",
      "Always run `pnpm publish --force` before pushing so that every package stays reviewable.",
    ].map((content) => extractParagraphs([document("/repo/AGENTS.md", content)])[0]);

    expect(lint?.normalized).toBe(publish?.normalized);
    expect(lint?.code).not.toBe(publish?.code);
    expect(lint?.hash).not.toBe(publish?.hash);
    expect(publish?.code).toContain("publish");
  });

  it("does not treat line wrapping or unmatched backticks as embedded code", () => {
    const oneLine = extractParagraphs([
      document(
        "/repo/AGENTS.md",
        "Always run the complete verification suite before merging because every package must remain healthy.",
      ),
    ])[0];
    const rewrapped = extractParagraphs([
      document(
        "/repo/CLAUDE.md",
        "Always run the complete verification suite before merging\nbecause every package must remain healthy.",
      ),
    ])[0];
    const strayTick = extractParagraphs([
      document(
        "/repo/rules.md",
        "Always `run the complete verification suite before merging because every package must remain healthy.",
      ),
    ])[0];

    expect(oneLine?.code).toBe("");
    expect(rewrapped?.code).toBe("");
    expect(strayTick?.code).toBe("");
    expect(rewrapped?.hash).toBe(oneLine?.hash);
    expect(strayTick?.hash).toBe(oneLine?.hash);
  });

  it("skips frontmatter containing blank lines without losing following line numbers", () => {
    const content = [
      "---",
      "description: Database migration instructions",
      "",
      "alwaysApply: false",
      "---",
      "Always keep database migrations backward compatible until every deployed service has upgraded.",
    ].join("\n");

    expect(extractParagraphs([document("/repo/rule.mdc", content)])).toMatchObject([
      { startLine: 6, endLine: 6 },
    ]);
  });

  it("skips setext headings and indented code blocks", () => {
    const content = [
      "A deliberately long heading that must not become duplicate instruction guidance",
      "---",
      "",
      "    Always run the destructive command because this is only a code example.",
      "",
      "Always keep database migrations backward compatible until every deployed service has upgraded.",
    ].join("\n");

    expect(extractParagraphs([document("/repo/AGENTS.md", content)])).toMatchObject([
      { startLine: 6, endLine: 6 },
    ]);
  });

  it("keeps guidance a nested list or a trailing thematic break would otherwise hide", () => {
    const nested = [
      "- Tooling rules",
      "    - Always run the complete verification suite before merging every single change.",
    ].join("\n");
    const beforeBreak = [
      "- Always run the complete verification suite before merging every single change.",
      "- Never force push to a shared branch.",
      "---",
    ].join("\n");

    expect(
      [nested, beforeBreak].map((content) =>
        extractParagraphs([document("/repo/AGENTS.md", content)]).map(
          (paragraph) => paragraph.normalized,
        ),
      ),
    ).toEqual([
      [
        "tooling rules always run the complete verification suite before merging every single change",
      ],
      [
        "always run the complete verification suite before merging every single change. never force push to a shared branch",
      ],
    ]);
  });

  it.each([
    [
      "Markdown table",
      "| Rule | Description |\n| --- | --- |\n| Verify | Run every test before merging a change |",
    ],
    [
      "license header",
      "Copyright 2026 Example Corporation. All rights reserved under the applicable license terms.",
    ],
    [
      "SPDX header",
      "SPDX-License-Identifier: Apache-2.0 with additional explanatory boilerplate for distribution.",
    ],
    ["frontmatter", "---\ndescription: Database migration instructions\nalwaysApply: false\n---"],
    ["short prose", "This instruction is intentionally short."],
  ])("filters %s noise", (_case, content) => {
    expect(extractParagraphs([document("/repo/rule.mdc", content)])).toEqual([]);
  });

  it("deduplicates repeated model entries by resolved absolute path", () => {
    const content =
      "Always keep database migrations backward compatible until every deployed service has upgraded.";
    const documents = [
      document("/repo/rules/../AGENTS.md", content),
      document("/repo/AGENTS.md", content),
    ];

    expect(extractParagraphs(documents)).toHaveLength(1);
  });

  it("orders document paths by code point instead of the host locale", () => {
    const content =
      "Always keep database migrations backward compatible until every deployed service has upgraded.";

    expect(
      extractParagraphs([
        document("/repo/ä.md", content),
        document("/repo/z.md", `${content} Carefully.`),
        document("/repo/😀.md", `${content} Thoroughly.`),
        document("/repo/\uE000.md", `${content} Safely.`),
      ]).map((paragraph) => paragraph.path),
    ).toEqual(["/repo/z.md", "/repo/ä.md", "/repo/\uE000.md", "/repo/😀.md"]);
  });
});
