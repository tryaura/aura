import { describe, expect, it } from "vitest";

import { highlightLabel, SEARCH_RESULT_CAP, searchOptions, searchTerms } from "./wizard-search.js";
import type { WizardOption } from "./wizard-types.js";

function option(label: string, extras: Partial<WizardOption> = {}): WizardOption {
  return { label, value: label.toLocaleLowerCase().replaceAll(" ", "-"), ...extras };
}

describe("searchOptions", () => {
  it("ranks a label word-start hit above substring, id, group, and description hits", () => {
    const options: readonly WizardOption[] = [
      option("archive", { description: "Handles jira exports." }),
      option("boards", { group: "Jira automation" }),
      option("cleanup", { value: "jira-cleanup" }),
      option("nojira-tools"),
      option("jira-triage"),
    ];

    const outcome = searchOptions(options, "jira");

    expect(outcome.total).toBe(5);
    expect(outcome.matched.map(({ label }) => label)).toEqual([
      "jira-triage",
      "nojira-tools",
      "cleanup",
      "boards",
      "archive",
    ]);
  });

  it("requires every term to match somewhere and keeps display order on ties", () => {
    const options: readonly WizardOption[] = [
      option("jira boards"),
      option("jira sprints"),
      option("confluence boards"),
    ];

    const outcome = searchOptions(options, "jira board");

    expect(outcome.matched.map(({ label }) => label)).toEqual(["jira boards"]);
    expect(outcome.total).toBe(1);
  });

  it("caps the rendered matches while reporting the full total", () => {
    const options = Array.from({ length: 1_117 }, (_, index) => option(`jira-${String(index)}`));

    const outcome = searchOptions(options, "jira");

    expect(outcome.total).toBe(1_117);
    expect(outcome.matched).toHaveLength(SEARCH_RESULT_CAP);
    expect(outcome.matched[0]?.label).toBe("jira-0");
  });
});

describe("highlightLabel", () => {
  const bold = (text: string): string => `<${text}>`;

  it("bolds each term's first occurrence", () => {
    expect(highlightLabel("jira board metrics", searchTerms("jira metrics"), bold)).toBe(
      "<jira> board <metrics>",
    );
  });

  it("merges overlapping term spans instead of nesting them", () => {
    expect(highlightLabel("jira-boards", searchTerms("jira-boa boards"), bold)).toBe(
      "<jira-boards>",
    );
  });

  it("matches case-insensitively and leaves unmatched labels alone", () => {
    expect(highlightLabel("Jira Triage", searchTerms("jira"), bold)).toBe("<Jira> Triage");
    expect(highlightLabel("Confluence", searchTerms("jira"), bold)).toBe("Confluence");
  });
});
