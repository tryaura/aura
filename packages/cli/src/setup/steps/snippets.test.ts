import { afterEach, describe, expect, it } from "vitest";

import { createScriptedWizardIo } from "../wizard-scripted.js";
import type { WizardAnswers, WizardQuestion } from "../wizard-types.js";
import { snippetsStep } from "./snippets.js";
import { cleanupFixtures } from "../testing.js";
import {
  askedOptions,
  context,
  createRoot,
  file,
  missingManifest,
  readyManifest,
  updateContext,
} from "./snippets.test-support.js";

afterEach(cleanupFixtures);

describe("snippets step", () => {
  it("orders the picker by category so each heading covers one run of rows", async () => {
    const root = await createRoot();
    const registry = [
      await file(root, "official/zulu", "safety"),
      await file(root, "official/alpha", "workflow"),
      await file(root, "official/bravo", "safety"),
    ];

    const options = await askedOptions(context(registry, missingManifest()));

    expect(options.map((option) => [option.group, option.value])).toEqual([
      ["safety", "official/bravo"],
      ["safety", "official/zulu"],
      ["workflow", "official/alpha"],
    ]);
  });

  it("labels and preselects a fresh preset snippet", async () => {
    const root = await createRoot();
    const presetSnippet = await file(root, "official/rules", "workflow");
    const stepContext = context([presetSnippet], missingManifest(), ["official/rules"]);
    const asked: WizardQuestion[] = [];
    const scripted = createScriptedWizardIo();

    const outcome = await snippetsStep.gather(stepContext, {
      ask: async (questions) => {
        asked.push(...questions);
        return scripted.ask(questions);
      },
      confirm: scripted.confirm,
      note: scripted.note,
    });

    expect(asked[0]?.initial).toEqual(["official/rules"]);
    expect(asked[0]?.options[0]?.label).toContain("(from preset)");
    expect(outcome).toEqual({ snippets: { selected: ["official/rules"] } });
  });

  it("keeps existing manifest selections authoritative over preset defaults", async () => {
    const root = await createRoot();
    const installed = await file(root, "official/installed", "workflow");
    const preset = await file(root, "official/preset", "workflow");
    const stepContext = context([installed, preset], readyManifest("official/installed"), [
      "official/preset",
    ]);
    const asked: WizardQuestion[] = [];
    const scripted = createScriptedWizardIo();

    await snippetsStep.gather(stepContext, {
      ask: async (questions) => {
        asked.push(...questions);
        return scripted.ask(questions);
      },
      confirm: scripted.confirm,
      note: scripted.note,
    });

    expect(asked[0]?.initial).toEqual(["official/installed"]);
  });

  it("keeps an installed revision by default and records an accepted reviewed update", async () => {
    const root = await createRoot();
    const id = "official/rules";
    const available = await file(root, id, "workflow", "new rules\n", "2.0.0");
    const stepContext = updateContext(available, "old rules");

    const kept = await snippetsStep.gather(stepContext, createScriptedWizardIo());
    const updated = await snippetsStep.gather(
      stepContext,
      createScriptedWizardIo({
        forms: [{}, { [`snippet-update:${id}`]: { kind: "options", values: ["update"] } }],
      }),
    );

    expect(kept).toEqual({ snippets: { selected: [id] } });
    expect(updated).toEqual({ snippets: { selected: [id], updates: [id] } });
  });

  it("returns to the picker rather than out of the step when a review is backed out of", async () => {
    // Leaving the step here would discard both the ticks of this pass and every review already
    // answered, so ← has to rewind into the picker instead.
    const root = await createRoot();
    const id = "official/rules";
    const available = await file(root, id, "workflow", "new rules\n", "2.0.0");
    const stepContext = updateContext(available, "old rules");
    const asked: WizardQuestion[] = [];
    const scripted = createScriptedWizardIo({ forms: [{}, "back", {}, {}] });

    const outcome = await snippetsStep.gather(stepContext, {
      ask: async (questions) => {
        asked.push(...questions);
        return scripted.ask(questions);
      },
      confirm: scripted.confirm,
      note: scripted.note,
    });

    expect(asked.map((question) => question.id)).toEqual([
      "snippets",
      `snippet-update:${id}`,
      "snippets",
      `snippet-update:${id}`,
    ]);
    expect(outcome).toEqual({ snippets: { selected: [id] } });
  });

  it("offers a source revision that is not newer as a deliberate switch", async () => {
    const root = await createRoot();
    const id = "official/rules";
    const rolledBack = await file(root, id, "workflow", "older rules\n", "0.9.0");
    const stepContext = updateContext(rolledBack, "old rules");
    const asked: WizardQuestion[] = [];
    const scripted = createScriptedWizardIo();

    await snippetsStep.gather(stepContext, {
      ask: async (questions) => {
        asked.push(...questions);
        return scripted.ask(questions);
      },
      confirm: scripted.confirm,
      note: scripted.note,
    });

    const review = asked.find((question) => question.id === `snippet-update:${id}`);
    expect(review?.prompt).toContain("which is not newer");
    expect(review?.options[1]?.label).toBe("Switch to 0.9.0");
  });

  it("keeps a cleared unavailable selection cleared", async () => {
    const stepContext = context([], readyManifest("retired/rules"));

    const outcome = await snippetsStep.gather(
      stepContext,
      createScriptedWizardIo({ forms: [{ snippets: { kind: "options", values: [] } }] }),
    );

    expect(outcome).toEqual({ snippets: { selected: [] } });
  });

  it("carries an unavailable selection the user left alone", async () => {
    const stepContext = context([], readyManifest("retired/rules"));
    const answered: WizardAnswers = {
      snippets: { kind: "options", values: ["retired/rules"] },
    };

    const outcome = await snippetsStep.gather(
      stepContext,
      createScriptedWizardIo({ forms: [answered] }),
    );

    expect(outcome).toEqual({ snippets: { selected: ["retired/rules"] } });
  });
});
