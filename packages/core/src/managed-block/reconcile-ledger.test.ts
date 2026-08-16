import { describe, expect, it } from "vitest";

import { readManagedBlock, reconcileManagedBlock, reconcileParsedManagedBlock } from "../index.js";

describe("managed-block ledger reconciliation", () => {
  it("removes only ledger-owned snippets and preserves foreign sections byte-for-byte", () => {
    const initial = reconcileManagedBlock("header\n", [
      { content: "Owned", id: "official/owned" },
      { content: "Foreign", id: "other/foreign" },
    ]).content;
    const editedForeign = initial.replace("Foreign\n", "Foreign hand edit\n");
    const foreignBefore = editedForeign.slice(
      editedForeign.indexOf("<!-- aura:begin id=other/foreign"),
      editedForeign.indexOf("<!-- aura:end id=other/foreign -->") +
        "<!-- aura:end id=other/foreign -->\n".length,
    );

    const result = reconcileManagedBlock(editedForeign, [], {
      ownedSnippetIds: ["official/owned"],
    });
    const parsed = readManagedBlock(result.content);

    expect(result.status).toBe("updated");
    expect(result.content).not.toContain("official/owned");
    expect(result.content).toContain(foreignBefore);
    expect(result.notes).toContainEqual({
      code: "preserved-unowned-snippet",
      line: 7,
      message:
        'Snippet "other/foreign" is not recorded in Aura\'s manifest; its section was preserved.',
    });
    expect(parsed.status).toBe("present");
  });

  it("preserves an unavailable owned section while reconciling the remaining ledger", () => {
    const initial = reconcileManagedBlock("", [
      { content: "Unavailable", id: "official/unavailable" },
      { content: "Remove", id: "official/remove" },
    ]).content;

    const result = reconcileManagedBlock(initial, [], {
      ownedSnippetIds: ["official/unavailable", "official/remove"],
      preserveSnippetIds: ["official/unavailable"],
    });

    expect(result.status).toBe("updated");
    expect(result.content).toContain("official/unavailable");
    expect(result.content).not.toContain("official/remove");
  });

  it("fails closed when a snippet is both desired and preserved", () => {
    const initial = reconcileManagedBlock("", [{ content: "Rules", id: "official/rules" }]).content;

    const result = reconcileManagedBlock(initial, [{ content: "Rules", id: "official/rules" }], {
      ownedSnippetIds: ["official/rules"],
      preserveSnippetIds: ["official/rules"],
    });

    expect(result.status).toBe("invalid");
    expect(result.content).toBe(initial);
    expect(result).toMatchObject({
      problems: [
        {
          code: "duplicate-snippet",
          message:
            'Snippet ID "official/rules" is both desired and preserved; writing both would duplicate it.',
        },
      ],
    });
    // The point of failing closed: emitting both sections leaves a file that never parses again.
    expect(readManagedBlock(result.content).status).toBe("present");
  });

  it("reuses a parse the caller already has", () => {
    const initial = reconcileManagedBlock("", [{ content: "Rules", id: "official/rules" }]).content;
    const desired = [{ content: "Rewritten", id: "official/rules" }];

    expect(reconcileParsedManagedBlock(initial, readManagedBlock(initial), desired)).toEqual(
      reconcileManagedBlock(initial, desired),
    );
  });
});
