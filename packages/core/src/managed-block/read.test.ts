import { describe, expect, expectTypeOf, it } from "vitest";

import {
  AURA_MANAGED_BLOCK_BEGIN,
  AURA_MANAGED_BLOCK_END,
  AURA_MANAGED_BLOCK_NOTICE,
  hashManagedSnippet,
  type ManagedBlockReadResult,
  readManagedBlock,
  reconcileManagedBlock,
} from "../index.js";
import { AURA_MANAGED_SNIPPET_BEGIN_PREFIX, AURA_MANAGED_SNIPPET_END_PREFIX } from "./protocol.js";

describe("managed-block reader", () => {
  it("exports stable HTML-comment protocol constants and result types", () => {
    expect(AURA_MANAGED_BLOCK_BEGIN).toBe("<!-- aura:begin -->");
    expect(AURA_MANAGED_BLOCK_END).toBe("<!-- aura:end -->");
    expect(AURA_MANAGED_SNIPPET_BEGIN_PREFIX).toBe("<!-- aura:begin id=");
    expect(AURA_MANAGED_SNIPPET_END_PREFIX).toBe("<!-- aura:end id=");
    expect(AURA_MANAGED_BLOCK_NOTICE).toContain("Managed by Aura.");
    expectTypeOf(readManagedBlock).returns.toEqualTypeOf<ManagedBlockReadResult>();
  });

  it("hashes canonical UTF-8 text with exactly one LF ending", () => {
    const expected = "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03";
    expect(hashManagedSnippet("hello")).toBe(expected);
    expect(hashManagedSnippet("hello\n\n")).toBe(expected);
    expect(hashManagedSnippet("hello\r\n")).toBe(expected);
    expect(hashManagedSnippet("hello\r")).toBe(expected);
    expect(hashManagedSnippet("")).toBe(
      "01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b",
    );
    expect(hashManagedSnippet("café")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports snippet contents, hashes, and source lines", () => {
    const written = reconcileManagedBlock("heading\n", [
      { content: "first", id: "official/first" },
      { content: "second", id: "official/second" },
    ]);
    const parsed = readManagedBlock(written.content);

    expect(parsed.status).toBe("present");
    if (parsed.status !== "present") {
      throw new Error("expected a managed block");
    }
    expect(parsed.notes).toEqual([]);
    expect(parsed.block).toMatchObject({ endLine: 10, startLine: 2, unmanagedContent: "" });
    expect(parsed.block.snippets).toHaveLength(2);
    expect(parsed.block.snippets[0]).toMatchObject({
      content: "first\n",
      endLine: 6,
      hashMatches: true,
      id: "official/first",
      startLine: 4,
    });
    expect(parsed.block.snippets[1]?.computedHash).toBe(parsed.block.snippets[1]?.storedHash);
  });

  it("exposes hand edits as hash mismatches without making the block malformed", () => {
    const original = reconcileManagedBlock("", [{ content: "canonical", id: "official/rules" }]);
    const edited = original.content.replace("canonical", "hand edited");
    const parsed = readManagedBlock(edited);

    expect(parsed.status).toBe("present");
    if (parsed.status !== "present") {
      throw new Error("expected a managed block");
    }
    expect(parsed.block.snippets[0]).toMatchObject({
      content: "hand edited\n",
      hashMatches: false,
    });
  });

  it("ignores marker-like comments inside Markdown fences", () => {
    const source = [
      "# Documentation",
      "```html",
      "<!-- aura:begin -->",
      "<!-- aura:begin id=example/rules sha256=bad -->",
      "<!-- aura:end id=example/rules -->",
      "<!-- aura:end -->",
      "```",
      "",
    ].join("\n");

    expect(readManagedBlock(source)).toEqual({ notes: [], status: "absent" });
  });

  it("allows marker examples inside a snippet's fenced content", () => {
    const content = [
      "```html",
      "<!-- aura:end id=official/rules -->",
      "<!-- aura:begin -->",
      "```",
    ].join("\n");
    const written = reconcileManagedBlock("", [{ content, id: "official/rules" }]);
    const parsed = readManagedBlock(written.content);

    expect(parsed.status).toBe("present");
    if (parsed.status !== "present") {
      throw new Error("expected a managed block");
    }
    expect(parsed.block.snippets[0]).toMatchObject({ hashMatches: true, id: "official/rules" });
  });

  it("returns a repair code and offending line for an orphaned outer marker", () => {
    const source = "before\n<!-- aura:end -->\nafter\n";
    const parsed = readManagedBlock(source);

    expect(parsed.status).toBe("invalid");
    if (parsed.status !== "invalid") {
      throw new Error("expected invalid managed state");
    }
    expect(parsed.problems).toContainEqual({
      code: "orphan-outer-end",
      line: 2,
      message: "Found an Aura outer end marker without a matching begin marker.",
    });
  });

  it.each([
    ["duplicate-block", emptyBlock() + emptyBlock()],
    [
      "nested-block",
      `${AURA_MANAGED_BLOCK_BEGIN}\n${AURA_MANAGED_BLOCK_BEGIN}\n${AURA_MANAGED_BLOCK_END}\n${AURA_MANAGED_BLOCK_END}\n`,
    ],
    ["incomplete-outer-block", `${AURA_MANAGED_BLOCK_BEGIN}\n`],
    [
      "outer-end-before-snippet-end",
      `${AURA_MANAGED_BLOCK_BEGIN}\n${AURA_MANAGED_BLOCK_NOTICE}\n${snippetBegin("official/a", "x")}\nx\n${AURA_MANAGED_BLOCK_END}\n`,
    ],
    [
      "mismatched-snippet-end",
      blockWith(snippetBegin("official/a", "x"), "x", "<!-- aura:end id=official/b -->"),
    ],
    [
      "invalid-hash",
      blockWith(
        "<!-- aura:begin id=official/a sha256=BAD -->",
        "x",
        "<!-- aura:end id=official/a -->",
      ),
    ],
    [
      "duplicate-snippet",
      `${AURA_MANAGED_BLOCK_BEGIN}\n${AURA_MANAGED_BLOCK_NOTICE}\n${snippet("official/a", "x")}${snippet("official/a", "y")}${AURA_MANAGED_BLOCK_END}\n`,
    ],
    [
      "invalid-snippet-id",
      blockWith(snippetBegin("official--bad", "x"), "x", "<!-- aura:end id=official--bad -->"),
    ],
    [
      "malformed-marker",
      `${AURA_MANAGED_BLOCK_BEGIN}\n${AURA_MANAGED_BLOCK_NOTICE}\n<!-- aura:begin id=official/a -->\n${AURA_MANAGED_BLOCK_END}\n`,
    ],
    ["orphan-snippet-marker", "<!-- aura:end id=official/a -->\n"],
  ])("fails closed for %s", (expectedCode, source) => {
    const parsed = readManagedBlock(source);
    const reconciled = reconcileManagedBlock(source, [{ content: "new", id: "official/new" }]);

    expect(parsed.status).toBe("invalid");
    if (parsed.status !== "invalid") {
      throw new Error("expected invalid managed state");
    }
    expect(parsed.problems.map((problem) => problem.code)).toContain(expectedCode);
    expect(parsed.problems.every((problem) => problem.line !== undefined)).toBe(true);
    expect(reconciled).toMatchObject({ content: source, status: "invalid" });
  });

  it("notes an unclosed fence that hid a marker instead of silently reporting absent", () => {
    const source = `# Doc\n\`\`\`\nexample\n${AURA_MANAGED_BLOCK_BEGIN}\n${AURA_MANAGED_BLOCK_END}\n`;
    const parsed = readManagedBlock(source);

    expect(parsed.status).toBe("absent");
    expect(parsed.notes).toEqual([
      {
        code: "unterminated-fence",
        line: 4,
        message:
          "An unclosed Markdown fence made this Aura marker ordinary text. Close the fence if the marker was meant to be read.",
      },
    ]);
  });

  it("stays silent when the fence that hid a marker is properly closed", () => {
    const source = `# Doc\n\`\`\`\n${AURA_MANAGED_BLOCK_BEGIN}\n\`\`\`\ntext\n`;

    expect(readManagedBlock(source)).toEqual({ notes: [], status: "absent" });
  });

  it("trims long newline runs in linear time", () => {
    const source = `${AURA_MANAGED_BLOCK_BEGIN}\n${snippetBegin("official/a", "\n".repeat(200_000) + "x")}\n${"\n".repeat(200_000)}x\n<!-- aura:end id=official/a -->\n${AURA_MANAGED_BLOCK_END}\n`;
    const started = process.hrtime.bigint();
    const parsed = readManagedBlock(source);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(parsed.status).toBe("present");
    expect(elapsedMs).toBeLessThan(2000);
  });
});

function emptyBlock(): string {
  return `${AURA_MANAGED_BLOCK_BEGIN}\n${AURA_MANAGED_BLOCK_NOTICE}\n${AURA_MANAGED_BLOCK_END}\n`;
}

function snippetBegin(id: string, content: string): string {
  return `<!-- aura:begin id=${id} sha256=${hashManagedSnippet(content)} -->`;
}

function snippet(id: string, content: string): string {
  return `${snippetBegin(id, content)}\n${content}\n<!-- aura:end id=${id} -->\n`;
}

function blockWith(begin: string, content: string, end: string): string {
  return `${AURA_MANAGED_BLOCK_BEGIN}\n${AURA_MANAGED_BLOCK_NOTICE}\n${begin}\n${content}\n${end}\n${AURA_MANAGED_BLOCK_END}\n`;
}
