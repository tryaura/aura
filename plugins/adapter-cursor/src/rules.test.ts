import type { AdapterSourceFile } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { parseRuleFile } from "./rules.js";

describe("Cursor rule references", () => {
  it("resolves file references relative to the rule", () => {
    const document = parse([
      "@service-template.ts",
      "@file ../api-guide.md",
      "See @./examples/example.ts for details.",
      "Repeat @service-template.ts once.",
    ]);

    expect(document.links).toEqual([
      {
        kind: "import",
        targetPath: "/workspace/.cursor/rules/service-template.ts",
        valid: false,
      },
      { kind: "import", targetPath: "/workspace/.cursor/api-guide.md", valid: false },
      {
        kind: "import",
        targetPath: "/workspace/.cursor/rules/examples/example.ts",
        valid: false,
      },
    ]);
  });

  it("surfaces activation frontmatter as metadata while keeping the full content", () => {
    const content =
      "---\ndescription: Database conventions\nglobs: migrations/**/*.sql\nalwaysApply: false\n---\n\nRead @schema.sql.\n";
    const document = parseRuleFile(ruleFile(content));

    expect(document.metadata).toEqual({
      alwaysApply: false,
      description: "Database conventions",
      globs: "migrations/**/*.sql",
    });
    expect(document.content).toBe(content);
  });

  it("reports no metadata for a rule without frontmatter", () => {
    expect(parse(["Plain rule body."]).metadata).toBeUndefined();
  });

  it("ignores mentions, packages, and references inside Markdown code", () => {
    const document = parse([
      "Ask @alice about @tryaura/core.",
      "Keep `@literal.md` literal.",
      "```md",
      "@fenced.md",
      "```",
      "Load @real.md.",
    ]);

    expect(document.links).toEqual([
      { kind: "import", targetPath: "/workspace/.cursor/rules/real.md", valid: false },
    ]);
  });
});

function parse(lines: readonly string[]): ReturnType<typeof parseRuleFile> {
  return parseRuleFile(ruleFile(lines.join("\n")));
}

function ruleFile(content: string): AdapterSourceFile {
  return {
    content,
    exists: true,
    spec: {
      id: "cursor.rules.project/example.mdc",
      kind: "instructions",
      path: "/workspace/.cursor/rules/example.mdc",
      scope: "project",
    },
  };
}
