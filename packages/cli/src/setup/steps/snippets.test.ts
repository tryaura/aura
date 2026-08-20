import { afterEach, describe, expect, it } from "vitest";

import { hashContent } from "@tryaura/core";

import { createScriptedWizardIo } from "../wizard-scripted.js";
import type { WizardQuestion } from "../wizard-types.js";
import { snippetsStep } from "./snippets.js";
import { cleanupFixtures } from "../testing.js";
import {
  askedNotes,
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
  forms?: Parameters<typeof createScriptedWizardIo>[0],
): Promise<{ asked: WizardQuestion[]; outcome: Awaited<ReturnType<typeof snippetsStep.gather>> }> {
  const asked: WizardQuestion[] = [];
  const scripted = createScriptedWizardIo(forms);
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

    const { asked, outcome } = await askedQuestions(stepContext);

    expect(asked[0]?.initial).toEqual(["official/rules"]);
    expect(asked[0]?.options[0]?.label).toContain("(from preset)");
    expect(outcome).toEqual({ snippets: { selected: ["official/rules"] } });
  });

  it("opens installed rows ticked and locked beside uninstalled preset defaults", async () => {
    const root = await createRoot();
    const installed = await file(root, "official/installed", "workflow");
    const preset = await file(root, "official/preset", "workflow");
    const stepContext = context([installed, preset], readyManifest("official/installed"), [
      "official/preset",
    ]);

    const { asked } = await askedQuestions(stepContext);

    const row = asked[0]?.options.find((option) => option.value === "official/installed");
    expect(asked[0]?.initial).toEqual(["official/installed", "official/preset"]);
    expect(row?.disabled).toBeUndefined();
    expect(row?.locked).toBe(true);
    expect(row?.label).toContain("(installed)");
  });

  it("keeps an untouched installed id out of both halves of the answer", async () => {
    const root = await createRoot();
    const installed = await file(root, "official/installed", "workflow");
    const available = await file(root, "official/available", "workflow");
    const stepContext = context([installed, available], readyManifest("official/installed"));

    const { outcome } = await askedQuestions(stepContext, {
      forms: [
        { snippets: { kind: "options", values: ["official/installed", "official/available"] } },
      ],
    });

    expect(outcome).toEqual({ snippets: { selected: ["official/available"] } });
  });

  // The row is locked, so an answer that omits it is a scripted caller's doing, not the user's;
  // either way there is no text Aura could take back and the record stands.
  it("keeps an installed id installed even when the answer omits it", async () => {
    const root = await createRoot();
    const installed = await file(root, "official/installed", "workflow");
    const stepContext = context([installed], readyManifest("official/installed"));

    const { outcome } = await askedQuestions(stepContext, {
      forms: [{ snippets: { kind: "options", values: [] } }],
    });

    expect(outcome).toEqual({ snippets: { selected: [] } });
  });

  it("reopens an installed id ticked after an earlier visit left it out", async () => {
    const root = await createRoot();
    const installed = await file(root, "official/installed", "workflow");
    const stepContext = {
      ...context([installed], readyManifest("official/installed")),
      selections: { snippets: { selected: [] } },
    };

    const { asked } = await askedQuestions(stepContext);

    expect(asked[0]?.initial).toEqual(["official/installed"]);
  });

  it("locks an installed id whose plugin is gone rather than offering it back", async () => {
    const stepContext = context([], readyManifest("retired/rules"));

    const options = await askedOptions(stepContext);

    expect(options.map((option) => option.value)).toEqual(["retired/rules"]);
    expect(options[0]?.disabled).toBeUndefined();
    expect(options[0]?.locked).toBe(true);
  });

  // A disabled row that opens ticked is an answer `--yes` has no way to take back, and the planner
  // would then drop the whole selection over a plugin that is merely absent.
  it("never opens a preset selection ticked when no plugin provides it", async () => {
    const root = await createRoot();
    const available = await file(root, "official/available", "workflow");
    const stepContext = context([available], missingManifest(), [
      "official/available",
      "ghost/rules",
    ]);

    const { asked, outcome } = await askedQuestions(stepContext);

    expect(asked[0]?.initial).toEqual(["official/available"]);
    expect(asked[0]?.options).toEqual(
      expect.arrayContaining([expect.objectContaining({ disabled: true, value: "ghost/rules" })]),
    );
    expect(outcome).toEqual({ snippets: { selected: ["official/available"] } });
  });

  it("says so when an installed snippet's text is no longer in the shared file", async () => {
    const root = await createRoot();
    const installed = await file(root, "official/rules", "workflow", "Body of official/rules.\n");
    const stepContext = context(
      [installed],
      readyManifest("official/rules", hashContent("Body of official/rules.\n")),
      [],
      "# My own guidance\n",
    );

    const notes = await askedNotes(stepContext);

    expect(notes).toEqual([
      expect.stringContaining("official/rules is recorded as installed, but its text is no longer"),
    ]);
  });

  it("says so when the plugin has moved on from the text it installed", async () => {
    const root = await createRoot();
    const installed = await file(root, "official/rules", "workflow", "Rewritten body.\n");
    const stepContext = context(
      [installed],
      readyManifest("official/rules", hashContent("Body as installed.\n")),
      [],
      "Body as installed.\n",
    );

    const notes = await askedNotes(stepContext);

    expect(notes).toEqual([
      expect.stringContaining("official/rules was installed from an earlier version of its source"),
    ]);
  });
});
