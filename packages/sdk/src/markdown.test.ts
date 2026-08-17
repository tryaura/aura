import { describe, expect, it } from "vitest";

import { maskMarkdownCode } from "./markdown.js";

describe("Markdown code masking", () => {
  it("masks four-space and tab-indented code while preserving line boundaries", () => {
    const source =
      "Visible guidance.\n\n    const hidden = true;\n\n\talsoHidden();\n\nVisible again.";

    expect(maskMarkdownCode(source).split("\n")).toEqual([
      "Visible guidance.",
      "",
      "                        ",
      "",
      "              ",
      "",
      "Visible again.",
    ]);
  });

  it("keeps indented list items and continuation lines visible", () => {
    const nested = "- Use pnpm across all projects\n    - never npm or yarn\n";
    const deep = "- Top\n  - Middle\n    - Deep item\n";
    const continuation = "Always run the full suite\n    including typecheck and lint\nbefore it.";
    const numbered = "1. First step\n2. Second step\n    Continued explanation of step two.\n";

    expect([nested, deep, continuation, numbered].map(maskMarkdownCode)).toEqual([
      nested,
      deep,
      continuation,
      numbered,
    ]);
  });

  it("masks code indented four columns past the enclosing list item", () => {
    expect(maskMarkdownCode("- Run the build:\n\n      pnpm build\n")).toBe(
      "- Run the build:\n\n                \n",
    );
  });

  it("masks an unmatched backtick delimiter without hiding the remaining prose", () => {
    expect(maskMarkdownCode("Always `run tests before merging.")).toBe(
      "Always  run tests before merging.",
    );
  });

  it("masks fenced code including the fence markers", () => {
    expect(maskMarkdownCode("Before\n```ts\nrun();\n```\nAfter")).toBe(
      "Before\n     \n      \n   \nAfter",
    );
  });

  it("does not close a four-backtick fence with a three-backtick line", () => {
    const source = "````md\n```\nstill code\n````\nvisible";

    expect(maskMarkdownCode(source)).toBe("      \n   \n          \n    \nvisible");
  });
});
