import { checksCorePlugin } from "@tryaura/aura-cli/plugins";
import { describe, expect, it } from "vitest";

describe("shipped check explanations", () => {
  it("gives every shipped check exactly two non-empty Markdown paragraphs", () => {
    expect(checksCorePlugin.checks).toHaveLength(19);

    for (const check of checksCorePlugin.checks ?? []) {
      const paragraphs = check.explain
        .trim()
        .split(/\n\s*\n/u)
        .map((paragraph) => paragraph.trim());
      expect(paragraphs, check.id).toHaveLength(2);
      expect(
        paragraphs.every((paragraph) => paragraph.length > 0),
        check.id,
      ).toBe(true);
    }
  });
});
