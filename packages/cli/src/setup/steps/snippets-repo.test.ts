import { afterEach, describe, expect, it } from "vitest";

import { createScriptedWizardIo } from "../wizard-scripted.js";
import type { WizardQuestion } from "../wizard-types.js";
import { snippetsStep } from "./snippets.js";
import { cleanupFixtures } from "../testing.js";
import {
  askedOptions,
  context,
  createRoot,
  file,
  missingManifest,
  readyManifest,
} from "./snippets.test-support.js";

afterEach(cleanupFixtures);

/** Runs the step, capturing the questions it asked on the way through. */
async function askedQuestions(
  stepContext: Parameters<typeof snippetsStep.gather>[0],
): Promise<{ asked: WizardQuestion[]; outcome: Awaited<ReturnType<typeof snippetsStep.gather>> }> {
  const asked: WizardQuestion[] = [];
  const scripted = createScriptedWizardIo();
  const outcome = await snippetsStep.gather(stepContext, {
    ask: async (questions) => {
      asked.push(...questions);
      return scripted.ask(questions);
    },
    confirm: scripted.confirm,
    load: scripted.load,
    note: scripted.note,
  });
  return { asked, outcome };
}

describe("snippets step with repository snippets", () => {
  it("leads the offered rows with the repository group, plugin categories underneath", async () => {
    const root = await createRoot();
    const registry = [
      await file(root, "official/alpha", "workflow"),
      await file(root, "official/bravo", "safety"),
    ];
    const stepContext = context(registry, missingManifest(), [], undefined, {
      snippets: [
        { body: "House rules.\n", id: "repo/conventions", name: "conventions" },
        { body: "Release steps.\n", id: "repo/releases", name: "releases" },
      ],
    });

    const options = await askedOptions(stepContext);

    expect(options.map((option) => [option.group, option.value])).toEqual([
      ["From this repository", "repo/conventions"],
      ["From this repository", "repo/releases"],
      ["safety", "official/bravo"],
      ["workflow", "official/alpha"],
    ]);
    expect(options[0]?.preview).toBe("House rules.\n");
  });

  it("leaves repo-selected snippets unticked for a non-interactive run", async () => {
    const stepContext = context([], missingManifest(), [], undefined, {
      selected: ["repo/conventions"],
      snippets: [
        { body: "House rules.\n", id: "repo/conventions", name: "conventions" },
        { body: "Optional extras.\n", id: "repo/extras", name: "extras" },
      ],
    });

    const { asked, outcome } = await askedQuestions(stepContext);

    expect(stepContext.interactive).toBe(false);
    expect(asked[0]?.initial).toEqual([]);
    const selectedRow = asked[0]?.options.find((option) => option.value === "repo/conventions");
    expect(selectedRow?.label).toContain("(from repo)");
    const unselectedRow = asked[0]?.options.find((option) => option.value === "repo/extras");
    expect(unselectedRow?.label).not.toContain("(from repo)");
    expect(outcome).toEqual({ snippets: { selected: [] } });
  });

  it("keeps an installed repo snippet in the locked record block", async () => {
    const stepContext = context([], readyManifest("repo/conventions"), [], undefined, {
      snippets: [{ body: "House rules.\n", id: "repo/conventions", name: "conventions" }],
    });

    const { asked } = await askedQuestions(stepContext);

    const row = asked[0]?.options.find((option) => option.value === "repo/conventions");
    expect(row?.group).toBe("Already installed");
    expect(row?.locked).toBe(true);
    expect(row?.note).toBe("From this repository");
  });
});
