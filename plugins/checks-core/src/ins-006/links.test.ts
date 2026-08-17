import { describe, expect, it } from "vitest";

import { model } from "../testing.js";
import { perSource, type ObservedLink } from "./links.js";

const SOURCE = "/workspace/AGENTS.md";

describe("capped per-source link reporting", () => {
  it("gives two applications distinct identities for the same overflowing source", () => {
    const summaries = ["codex", "other"].map((adapterId) => {
      const findings = perSource(brokenLinks(25), () => "unsupported", describeLink, model(), {
        overflowScope: [adapterId],
      });
      return findings[findings.length - 1];
    });

    expect(summaries.map((summary) => summary?.metadata?.["hidden"])).toEqual([5, 5]);
    expect(summaries[0]?.id).not.toBe(summaries[1]?.id);
    expect(summaries[0]?.id).toMatch(/^unsupported:[0-9a-f]{16}$/u);
  });

  it("keeps one identity per source when no application scopes the summary", () => {
    const withoutScope = perSource(brokenLinks(25), () => "missing", describeLink, model());
    const again = perSource(brokenLinks(25), () => "missing", describeLink, model());

    expect(withoutScope[20]?.id).toBe(again[20]?.id);
  });

  it("never describes a link the cap already dropped", () => {
    const described: string[] = [];
    const findings = perSource(
      brokenLinks(5_000),
      () => "missing",
      (link, failure) => {
        described.push(link.targetPath);
        return describeLink(link, failure);
      },
      model(),
    );

    expect(described).toHaveLength(20);
    expect(findings).toHaveLength(21);
    expect(findings[20]?.metadata?.["hidden"]).toBe(4_980);
  });
});

function brokenLinks(count: number): readonly ObservedLink[] {
  return Array.from({ length: count }, (_value, index) => ({
    kind: "import" as const,
    sourcePath: SOURCE,
    targetPath: `/workspace/gone-${String(index).padStart(4, "0")}.md`,
    valid: false,
  }));
}

function describeLink(link: ObservedLink, failure: string) {
  return {
    id: `${failure}:${link.targetPath}`,
    locations: [{ path: link.sourcePath }],
    message: `${link.sourcePath} links to ${link.targetPath}.`,
    metadata: { failure, sourcePath: link.sourcePath },
  };
}
