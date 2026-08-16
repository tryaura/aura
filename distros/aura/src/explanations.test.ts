import checksCore from "@tryaura/checks-core";
import { describe, expect, it } from "vitest";

describe("shipped check explanations", () => {
  it("gives every shipped check exactly two non-empty Markdown paragraphs", () => {
    expect(checksCore.checks).toHaveLength(13);

    for (const check of checksCore.checks ?? []) {
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
