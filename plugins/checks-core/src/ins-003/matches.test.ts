import { describe, expect, it } from "vitest";

import { clusterMatches } from "./clusters.js";
import {
  findMatches,
  jaccard,
  lengthBandPairs,
  NEAR_DUPLICATE_THRESHOLD,
  tokenShingles,
  type ParagraphMatch,
} from "./matches.js";
import { sha256, type InstructionParagraph } from "./paragraphs.js";

describe("INS-003 similarity matching", () => {
  it("includes the 70% length boundary and prunes pairs outside it", () => {
    const paragraphs = [
      paragraph("a".repeat(100), "/a"),
      paragraph("b".repeat(70), "/b"),
      paragraph("c".repeat(69), "/c"),
    ];

    expect([...lengthBandPairs(paragraphs)]).toEqual([
      [1, 2],
      [0, 1],
    ]);
  });

  it("does not match paragraphs whose embedded code differs", () => {
    const normalized = numberedTokens(20);

    expect(
      findMatches([
        paragraph(normalized, "/a", { code: "pnpm lint" }),
        paragraph(normalized, "/b", { code: "pnpm publish --force" }),
      ]),
    ).toEqual([]);
  });

  it("scores a one-token drift in a long paragraph above the near-duplicate threshold", () => {
    const original = numberedTokens(40);
    const changed = original.replace("token20", "replacement");
    const similarity = jaccard(tokenShingles(original), tokenShingles(changed));

    expect(similarity).toBeGreaterThanOrEqual(NEAR_DUPLICATE_THRESHOLD);
    expect(similarity).toBeLessThan(0.9);
    expect(findMatches([paragraph(original, "/a"), paragraph(changed, "/b")])).toMatchObject([
      { kind: "near", left: 0, right: 1 },
    ]);
  });

  it("does not match paragraphs below the threshold", () => {
    const original = numberedTokens(18);
    const changed = original.replace("token9", "replacement");

    expect(findMatches([paragraph(original, "/a"), paragraph(changed, "/b")])).toEqual([]);
  });

  it("reports exact matches only across distinct compatible files", () => {
    const normalized = numberedTokens(20);
    expect(
      findMatches([
        paragraph(normalized, "/a"),
        paragraph(normalized, "/a", { startLine: 8 }),
        paragraph(normalized, "/conditional.mdc", {
          conditional: true,
          scope: "project",
        }),
        paragraph(normalized, "/global", { scope: "global" }),
        paragraph(normalized, "/project", { scope: "project" }),
      ]),
    ).toEqual([
      { kind: "exact", left: 0, right: 3, similarity: 1 },
      { kind: "exact", left: 0, right: 4, similarity: 1 },
      { kind: "exact", left: 1, right: 3, similarity: 1 },
      { kind: "exact", left: 1, right: 4, similarity: 1 },
      { kind: "exact", left: 2, right: 4, similarity: 1 },
      { kind: "exact", left: 3, right: 4, similarity: 1 },
    ]);
  });

  it("clusters transitive matches deterministically", () => {
    const matches = [match(2, 3, 0.86), match(0, 1, 1), match(1, 2, 0.9), match(7, 8, 1)];

    expect(clusterMatches(matches)).toEqual([
      { matches: matches.slice(0, 3), members: [0, 1, 2, 3] },
      { matches: [matches[3]], members: [7, 8] },
    ]);
  });
});

function numberedTokens(count: number): string {
  return Array.from({ length: count }, (_value, index) => `token${index + 1}`).join(" ");
}

function paragraph(
  normalized: string,
  path: string,
  options: {
    readonly code?: string;
    readonly conditional?: boolean;
    readonly scope?: InstructionParagraph["scope"];
    readonly startLine?: number;
  } = {},
): InstructionParagraph {
  const code = options.code ?? "";
  return {
    code,
    conditional: options.conditional ?? false,
    endLine: options.startLine ?? 1,
    hash: sha256(`${normalized} ${code}`),
    normalized,
    path,
    scope: options.scope ?? "global",
    startLine: options.startLine ?? 1,
  };
}

function match(left: number, right: number, similarity: number): ParagraphMatch {
  return { kind: similarity === 1 ? "exact" : "near", left, right, similarity };
}
