import { describe, expect, expectTypeOf, it } from "vitest";

import {
  AURA_MANAGED_BLOCK_BEGIN,
  diffManagedSnippet,
  type ManagedSnippetResolution,
  readManagedBlock,
  reconcileManagedBlock,
  reconcileManagedSnippet,
} from "../index.js";

describe("targeted managed-snippet reconciliation", () => {
  it("exports a typed targeted resolution contract", () => {
    expectTypeOf(reconcileManagedSnippet).parameter(2).toEqualTypeOf<ManagedSnippetResolution>();
  });

  it("keeps one edited snippet without changing its body, neighbors, or surrounding bytes", () => {
    const written = reconcileManagedBlock("before\r\n", [
      { content: "Alpha", id: "official/a" },
      { content: "Beta", id: "official/b" },
    ]).content;
    const source = `${written.replace("Alpha\r\n", "Alpha edited\r\n").replace("Beta\r\n", "Beta edited\r\n")}after`;
    const before = readManagedBlock(source);
    if (before.status !== "present") {
      throw new Error("expected a managed block");
    }
    const untouched = before.block.snippets[1];
    if (untouched === undefined) {
      throw new Error("expected the second snippet");
    }
    const untouchedBytes = source.slice(untouched.startOffset, untouched.endOffset);

    const result = reconcileManagedSnippet(source, "official/a", { kind: "keep" });
    const parsed = readManagedBlock(result.content);

    expect(result.status).toBe("updated");
    expect(result.content.startsWith("before\r\n")).toBe(true);
    expect(result.content.endsWith("after")).toBe(true);
    expect(result.content).toContain("Alpha edited\r\n");
    expect(result.content).toContain(untouchedBytes);
    expect(parsed.status).toBe("present");
    if (parsed.status !== "present") {
      throw new Error("expected a managed block");
    }
    expect(parsed.block.snippets.map((snippet) => snippet.hashMatches)).toEqual([true, false]);
  });

  it("restores one snippet from canonical content without touching adjacent content", () => {
    const written = reconcileManagedBlock("before\n", [
      { content: "Alpha", id: "official/a" },
      { content: "Beta", id: "official/b" },
    ]).content;
    const source = `${written.replace("Alpha\n", "hand edit\n")}after`;
    const result = reconcileManagedSnippet(source, "official/a", {
      content: "Canonical replacement\n\n",
      kind: "restore",
    });

    expect(result.status).toBe("updated");
    expect(result.content.startsWith("before\n")).toBe(true);
    expect(result.content.endsWith("after")).toBe(true);
    expect(result.content).toContain("Canonical replacement\n<!-- aura:end id=official/a -->");
    expect(result.content).toContain("Beta\n<!-- aura:end id=official/b -->");
    const parsed = readManagedBlock(result.content);
    expect(parsed.status).toBe("present");
    if (parsed.status !== "present") {
      throw new Error("expected a managed block");
    }
    expect(parsed.block.snippets.every((snippet) => snippet.hashMatches)).toBe(true);
  });

  it("fails closed for malformed blocks and missing target snippets", () => {
    const malformed = `${AURA_MANAGED_BLOCK_BEGIN}\n`;
    const valid = reconcileManagedBlock("outside\n", [
      { content: "Alpha", id: "official/a" },
    ]).content;

    expect(reconcileManagedSnippet(malformed, "official/a", { kind: "keep" })).toMatchObject({
      content: malformed,
      status: "invalid",
    });
    expect(reconcileManagedSnippet(valid, "official/missing", { kind: "keep" })).toMatchObject({
      content: valid,
      problems: [{ code: "missing-snippet" }],
      status: "invalid",
    });
  });

  it("refuses replacement content that would escape its own snippet", () => {
    const source = reconcileManagedBlock("before\n", [
      { content: "Alpha", id: "official/a" },
    ]).content.replace("Alpha\n", "hand edit\n");

    for (const content of [
      "Use the marker:\n<!-- aura:end id=official/a -->\nDone.\n",
      "Example:\n```markdown\nunterminated\n",
    ]) {
      const result = reconcileManagedSnippet(source, "official/a", { content, kind: "restore" });

      expect(result).toMatchObject({
        content: source,
        problems: [{ code: "invalid-snippet-content" }],
        status: "invalid",
      });
      // The whole-block writer refuses the same bytes; a targeted write must not be the way around it.
      expect(reconcileManagedBlock("before\n", [{ content, id: "official/a" }])).toMatchObject({
        problems: [{ code: "invalid-snippet-content" }],
        status: "invalid",
      });
    }
  });

  it("renders an opt-in unified diff for merge guidance", () => {
    const detail = diffManagedSnippet("/home/dev/agents/AGENTS.md", "edited\n", "canonical");

    expect(detail).toContain("--- /home/dev/agents/AGENTS.md (edited)");
    expect(detail).toContain("+++ /home/dev/agents/AGENTS.md (canonical)");
    expect(detail).toContain("-edited");
    expect(detail).toContain("+canonical");
  });
});
