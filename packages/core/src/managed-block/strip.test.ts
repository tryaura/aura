import { describe, expect, it } from "vitest";

import { stripLegacyManagedBlock } from "./strip.js";

const BLOCK = [
  "<!-- aura:begin -->",
  "Managed by Aura. Edit via the Aura CLI; manual edits to this block are overwritten.",
  "<!-- aura:begin id=shared-instructions sha256=0000000000000000000000000000000000000000000000000000000000000000 -->",
  "@~/agents/AGENTS.md",
  "<!-- aura:end id=shared-instructions -->",
  "<!-- aura:end -->",
  "",
].join("\n");

describe("stripLegacyManagedBlock", () => {
  it("removes the block and keeps surrounding text byte-for-byte", () => {
    const before = "# Mine\n\nKeep this.\n";
    const after = "And this afterwards.\n";

    expect(stripLegacyManagedBlock(`${before}${BLOCK}${after}`)).toBe(`${before}${after}`);
  });

  it("keeps unmanaged lines a user wrote inside the block", () => {
    const source = [
      "<!-- aura:begin -->",
      "<!-- aura:begin id=shared-instructions sha256=0000000000000000000000000000000000000000000000000000000000000000 -->",
      "@~/agents/AGENTS.md",
      "<!-- aura:end id=shared-instructions -->",
      "A line someone typed here by hand.",
      "<!-- aura:end -->",
      "",
    ].join("\n");

    expect(stripLegacyManagedBlock(source)).toBe("A line someone typed here by hand.\n");
  });

  it("returns a source without a block unchanged", () => {
    const source = "# Plain instructions\n\nNothing managed here.\n";

    expect(stripLegacyManagedBlock(source)).toBe(source);
  });

  it("returns a source whose block does not parse unchanged", () => {
    const source = "# Broken\n\n<!-- aura:begin -->\nnever closed\n";

    expect(stripLegacyManagedBlock(source)).toBe(source);
  });

  it("preserves CRLF content around the removed block", () => {
    const source = `Keep A.\r\n${BLOCK.replaceAll("\n", "\r\n")}Keep B.\r\n`;

    expect(stripLegacyManagedBlock(source)).toBe("Keep A.\r\nKeep B.\r\n");
  });
});
