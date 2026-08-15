import { describe, expect, expectTypeOf, it } from "vitest";

import {
  AURA_MANAGED_BLOCK_BEGIN,
  AURA_MANAGED_BLOCK_END,
  AURA_MANAGED_BLOCK_NOTICE,
  type DesiredManagedSnippet,
  hashManagedSnippet,
  type ManagedBlockWriteResult,
  readManagedBlock,
  reconcileManagedBlock,
} from "../index.js";

describe("managed-block reconciliation", () => {
  it("exports a typed string-in/string-out contract", () => {
    expectTypeOf(reconcileManagedBlock)
      .parameter(1)
      .toEqualTypeOf<readonly DesiredManagedSnippet[]>();
    expectTypeOf(reconcileManagedBlock).returns.toEqualTypeOf<ManagedBlockWriteResult>();
  });

  it("inserts deterministic HTML comments and the unhashed notice", () => {
    const hash = hashManagedSnippet("Use pnpm");
    const result = reconcileManagedBlock("# Team rules\n", [
      { content: "Use pnpm", id: "official/package-manager" },
    ]);

    expect(result).toEqual({
      content:
        "# Team rules\n" +
        `${AURA_MANAGED_BLOCK_BEGIN}\n` +
        `${AURA_MANAGED_BLOCK_NOTICE}\n` +
        `<!-- aura:begin id=official/package-manager sha256=${hash} -->\n` +
        "Use pnpm\n" +
        "<!-- aura:end id=official/package-manager -->\n" +
        `${AURA_MANAGED_BLOCK_END}\n`,
      notes: [],
      status: "updated",
    });
  });

  it("adds, updates, removes, and reorders the complete desired set", () => {
    const initial = reconcileManagedBlock("intro\noutro\n", [
      { content: "Alpha", id: "official/a" },
      { content: "Beta", id: "official/b" },
      { content: "Removed", id: "official/removed" },
    ]);
    const updated = reconcileManagedBlock(initial.content, [
      { content: "Beta updated", id: "official/b" },
      { content: "Alpha", id: "official/a" },
      { content: "Added", id: "official/added" },
    ]);
    const parsed = readManagedBlock(updated.content);

    expect(updated.status).toBe("updated");
    expect(updated.content.startsWith("intro\noutro\n")).toBe(true);
    expect(updated.content).not.toContain("official/removed");
    expect(parsed.status).toBe("present");
    if (parsed.status !== "present") {
      throw new Error("expected a managed block");
    }
    expect(parsed.block.snippets.map((snippet) => snippet.id)).toEqual([
      "official/b",
      "official/a",
      "official/added",
    ]);
    expect(parsed.block.snippets[0]?.content).toBe("Beta updated\n");
  });

  it("removes the outer block with the last snippet and preserves both sides", () => {
    const block = reconcileManagedBlock("", [{ content: "Managed", id: "official/a" }]).content;
    const source = `\uFEFFhandwritten before\r\n${block.replaceAll("\n", "\r\n")}handwritten after`;
    const result = reconcileManagedBlock(source, []);

    expect(result).toEqual({
      content: "\uFEFFhandwritten before\r\nhandwritten after",
      notes: [],
      status: "updated",
    });
  });

  it("is byte-for-byte idempotent on a second reconciliation", () => {
    const desired = [
      { content: "One\r\n\r\n", id: "official/one" },
      { content: "Two", id: "official/two" },
    ];
    const first = reconcileManagedBlock("header\r\n", desired);
    const second = reconcileManagedBlock(first.content, desired);

    expect(first.status).toBe("updated");
    expect(first.content).toContain("One\r\n<!-- aura:end id=official/one -->\r\n");
    expect(second).toEqual({
      content: first.content,
      notes: [],
      status: "unchanged",
    });
  });

  it("overwrites a hash-mismatched snippet and reports the discarded hand edit", () => {
    const first = reconcileManagedBlock("", [{ content: "canonical", id: "official/rules" }]);
    const edited = first.content.replace("canonical\n", "hand edit\n");
    const updated = reconcileManagedBlock(edited, [{ content: "canonical", id: "official/rules" }]);

    expect(updated.content).toBe(first.content);
    expect(updated.status).toBe("updated");
    expect(updated.notes).toEqual([
      {
        code: "overwritten-snippet",
        line: 3,
        message:
          'Snippet "official/rules" was edited by hand since Aura wrote it; the edit is being replaced.',
      },
    ]);
  });

  it("hoists stray block text byte-for-byte and then becomes idempotent", () => {
    const hash = hashManagedSnippet("old");
    const prefix = "\uFEFF# Heading\r\n";
    const stray = "keep this text  \r\n \t\r\n";
    const suffix = "handwritten after without final newline";
    const source =
      prefix +
      `${AURA_MANAGED_BLOCK_BEGIN}\r\n` +
      `${AURA_MANAGED_BLOCK_NOTICE}\r\n` +
      stray +
      `<!-- aura:begin id=official/rules sha256=${hash} -->\r\n` +
      "old\r\n" +
      "<!-- aura:end id=official/rules -->\r\n" +
      `${AURA_MANAGED_BLOCK_END}\r\n` +
      suffix;

    const first = reconcileManagedBlock(source, [{ content: "new", id: "official/rules" }]);
    const second = reconcileManagedBlock(first.content, [{ content: "new", id: "official/rules" }]);

    expect(first.status).toBe("updated");
    expect(first.notes).toHaveLength(2);
    expect(first.notes[0]).toMatchObject({ code: "unmanaged-content", line: 4 });
    expect(first.content.startsWith(prefix)).toBe(true);
    expect(first.content.endsWith(`${AURA_MANAGED_BLOCK_END}\r\n${stray}${suffix}`)).toBe(true);
    expect(second).toEqual({
      content: first.content,
      notes: [],
      status: "unchanged",
    });
  });

  it("preserves gnarly surrounding bytes while normalizing only the block", () => {
    const prefix = "\uFEFF# Heading\r\n```html\r\n<!-- aura:begin -->\r\n```\r\n\r\n";
    const suffix = "\r\n  trailing spaces  \r\nno final newline";
    const oldBlock = reconcileManagedBlock("", [{ content: "old", id: "official/rules" }]).content;
    const source = `${prefix}${oldBlock.replaceAll("\n", "\r\n").trimEnd()}${suffix}`;
    const result = reconcileManagedBlock(source, [{ content: "new\n\n", id: "official/rules" }]);

    expect(result.content.startsWith(prefix)).toBe(true);
    expect(result.content.endsWith(suffix)).toBe(true);
    expect(result.content).toContain("new\r\n<!-- aura:end id=official/rules -->");
  });

  it("rejects line-unsafe, comment-breaking, or duplicate desired IDs", () => {
    const source = "handwritten\n";
    const unsafe = reconcileManagedBlock(source, [{ content: "x", id: "bad:id" }]);
    const commentBreaking = reconcileManagedBlock(source, [{ content: "x", id: "official--bad" }]);
    const duplicate = reconcileManagedBlock(source, [
      { content: "x", id: "official/a" },
      { content: "y", id: "official/a" },
    ]);

    for (const result of [unsafe, commentBreaking, duplicate]) {
      expect(result).toMatchObject({ content: source, status: "invalid" });
    }
  });

  it.each([
    ["closes its own snippet", "hello\n<!-- aura:end id=official/a -->\nescaped"],
    ["closes the outer block", "hello\n<!-- aura:end -->\nescaped"],
    ["forges a snippet marker", `<!-- aura:begin id=other sha256=${"0".repeat(64)} -->`],
    ["opens a fence it never closes", "```html\nnot closed"],
  ])("refuses desired content that %s", (_label, content) => {
    const source = "# doc\n";
    const result = reconcileManagedBlock(source, [{ content, id: "official/a" }]);

    expect(result).toMatchObject({ content: source, status: "invalid" });
    if (result.status !== "invalid") {
      throw new Error("expected invalid managed state");
    }
    expect(result.problems.map((problem) => problem.code)).toContain("invalid-snippet-content");
  });

  it("still allows marker examples inside a closed fence", () => {
    const content = "```html\n<!-- aura:end -->\n```";
    const result = reconcileManagedBlock("# doc\n", [{ content, id: "official/a" }]);

    expect(result.status).toBe("updated");
    expect(readManagedBlock(result.content).status).toBe("present");
  });

  it("repairs an unmanageable file on request and stays idempotent afterwards", () => {
    const source = `# doc\nhandwritten\n${AURA_MANAGED_BLOCK_END}\ntail\n`;
    const desired = [{ content: "rule", id: "official/a" }];

    expect(reconcileManagedBlock(source, desired).status).toBe("invalid");

    const repaired = reconcileManagedBlock(source, desired, { onInvalid: "repair" });
    const again = reconcileManagedBlock(repaired.content, desired, { onInvalid: "repair" });

    expect(repaired.status).toBe("updated");
    expect(repaired.content.startsWith("# doc\nhandwritten\ntail\n")).toBe(true);
    expect(repaired.notes).toEqual([
      {
        code: "repaired-invalid-block",
        line: 3,
        message:
          "Rebuilt the managed block to repair: Found an Aura outer end marker without a matching begin marker.",
      },
    ]);
    expect(readManagedBlock(repaired.content).status).toBe("present");
    expect(again.status).toBe("unchanged");
  });

  it("keeps failing closed on invalid input when repair is not requested", () => {
    const source = `${AURA_MANAGED_BLOCK_BEGIN}\n`;

    expect(reconcileManagedBlock(source, [{ content: "x", id: "official/a" }])).toMatchObject({
      content: source,
      status: "invalid",
    });
    expect(
      reconcileManagedBlock(source, [{ content: "x", id: "official/a" }], { onInvalid: "fail" }),
    ).toMatchObject({ content: source, status: "invalid" });
  });

  it("leaves an absent block unchanged when no snippets are desired", () => {
    expect(reconcileManagedBlock("handwritten", [])).toEqual({
      content: "handwritten",
      notes: [],
      status: "unchanged",
    });
  });
});
