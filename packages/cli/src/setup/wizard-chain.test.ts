/* eslint-disable max-lines -- one navigation matrix shares the same stage fixtures. */
import { describe, expect, it } from "vitest";

import { SETUP_ABORTED, SETUP_BACK } from "./types.js";
import { runFormChain, type ChainStage } from "./wizard-chain.js";
import { createScriptedWizardIo } from "./wizard-scripted.js";
import { selectedValues, type WizardQuestion } from "./wizard-types.js";

interface State {
  readonly kind?: string | undefined;
  readonly extra?: string | undefined;
}

function question(
  id: string,
  values: readonly string[],
  initial?: readonly string[],
): WizardQuestion {
  return {
    id,
    initial: initial ?? [values[0] ?? ""],
    kind: "select",
    label: id,
    options: values.map((value) => ({ label: value, value })),
    prompt: `Pick ${id}`,
  };
}

const kindStage: ChainStage<State> = {
  apply: (state, answers) => ({ ...state, kind: selectedValues(answers["kind"])[0] }),
  label: "Kind",
  questions: (state) => [
    question("kind", ["plain", "fancy"], state.kind === undefined ? undefined : [state.kind]),
  ],
};

/** Only fancy things get an extra question; the stage disappears otherwise. */
const extraStage: ChainStage<State> = {
  apply: (state, answers) => ({ ...state, extra: selectedValues(answers["extra"])[0] }),
  label: "Extra",
  questions: (state) =>
    state.kind === "fancy" ? [question("extra", ["gold", "silver"])] : undefined,
};

describe("runFormChain", () => {
  it("skips stages whose precondition does not hold", async () => {
    const io = createScriptedWizardIo({
      forms: [{ kind: { kind: "options", values: ["plain"] } }],
    });

    const result = await runFormChain([kindStage, extraStage], {}, io);

    expect(result).toEqual({ kind: "plain" });
  });

  it("rewinds to the previously asked stage on back and regrows the chain", async () => {
    const io = createScriptedWizardIo({
      forms: [
        { kind: { kind: "options", values: ["fancy"] } },
        "back",
        { kind: { kind: "options", values: ["fancy"] } },
        { extra: { kind: "options", values: ["silver"] } },
      ],
    });

    const result = await runFormChain([kindStage, extraStage], {}, io);

    expect(result).toEqual({ kind: "fancy", extra: "silver" });
  });

  it("returns SETUP_BACK when the first asked stage backs out", async () => {
    const io = createScriptedWizardIo({ forms: ["back"] });

    await expect(runFormChain([kindStage, extraStage], {}, io)).resolves.toBe(SETUP_BACK);
  });

  it("enters at the last answered stage when opened from the end", async () => {
    const asked: string[] = [];
    const base = createScriptedWizardIo({
      forms: ["back", {}, {}],
    });
    const io = {
      ...base,
      ask: async (questions: readonly WizardQuestion[]) => {
        asked.push(questions[0]?.id ?? "?");
        return base.ask(questions);
      },
    };

    const result = await runFormChain(
      [kindStage, extraStage],
      { extra: "gold", kind: "fancy" },
      io,
      { entry: "end" },
    );

    // Opens on "extra"; ← walks to "kind"; forward re-asks both with the seeded answers.
    expect(asked).toEqual(["extra", "kind", "extra"]);
    expect(result).toEqual({ extra: "gold", kind: "fancy" });
  });

  it("passes straight through backward when nothing would be asked", async () => {
    const silent: ChainStage<State> = {
      apply: (state) => state,
      label: "Silent",
      questions: () => undefined,
    };

    await expect(
      runFormChain([silent], {}, createScriptedWizardIo(), { entry: "end" }),
    ).resolves.toBe(SETUP_BACK);
  });

  it("threads the base flow with live sub progress into every ask", async () => {
    const flows: unknown[] = [];
    const base = createScriptedWizardIo({
      forms: [
        { kind: { kind: "options", values: ["fancy"] } },
        "back",
        { kind: { kind: "options", values: ["fancy"] } },
        {},
      ],
    });
    const io = {
      ...base,
      ask: async (questions: readonly WizardQuestion[], flow?: unknown) => {
        flows.push(flow);
        return base.ask(questions);
      },
    };
    const stepFlow = {
      completed: [{ label: "Applications" }],
      step: { label: "Instructions" },
      upcoming: [],
    };

    await runFormChain([kindStage, extraStage], {}, io, { flow: stepFlow });

    expect(flows).toEqual([
      // "Extra" is hidden until the fancy answer triggers it: the honest map.
      { ...stepFlow, sub: { completed: [], upcoming: [] } },
      { ...stepFlow, sub: { completed: [{ label: "Kind" }], upcoming: [] } },
      // Rewound: history popped, so Kind's re-ask has no completed stages again.
      { ...stepFlow, sub: { completed: [], upcoming: [] } },
      { ...stepFlow, sub: { completed: [{ label: "Kind" }], upcoming: [] } },
    ]);
  });

  it("passes no flow to asks when the chain runs without one", async () => {
    const flows: unknown[] = [];
    const base = createScriptedWizardIo({
      forms: [{ kind: { kind: "options", values: ["plain"] } }],
    });
    const io = {
      ...base,
      ask: async (questions: readonly WizardQuestion[], flow?: unknown) => {
        flows.push(flow);
        return base.ask(questions);
      },
    };

    await runFormChain([kindStage, extraStage], {}, io);

    expect(flows).toEqual([undefined]);
  });

  it("uses applicability checks instead of materializing upcoming questions", async () => {
    const materialized: string[] = [];
    const stages: readonly ChainStage<State>[] = ["first", "second", "third"].map((id) => ({
      apply: (state) => state,
      isApplicable: () => true,
      label: id,
      questions: () => {
        materialized.push(id);
        return [question(id, ["done"])];
      },
    }));

    await runFormChain(stages, {}, createScriptedWizardIo(), {
      flow: { completed: [], upcoming: [] },
    });

    expect(materialized).toEqual(["first", "second", "third"]);
  });

  it("propagates an abort from any stage", async () => {
    const io = createScriptedWizardIo({
      forms: [{ kind: { kind: "options", values: ["fancy"] } }, "aborted"],
    });

    await expect(runFormChain([kindStage, extraStage], {}, io)).resolves.toBe(SETUP_ABORTED);
  });

  it("re-seeds a re-asked question with the answer it got before", async () => {
    const seen: (readonly string[] | undefined)[] = [];
    const spyIo = createScriptedWizardIo({
      forms: [
        { kind: { kind: "options", values: ["fancy"] } },
        { extra: { kind: "options", values: ["silver"] } },
        "back",
        {},
      ],
    });
    const io = {
      ...spyIo,
      ask: async (questions: readonly WizardQuestion[]) => {
        seen.push(questions[0]?.initial);
        return spyIo.ask(questions);
      },
    };

    // kind → extra(silver) → back from a third stage → extra re-asked, seeded with silver.
    const third: ChainStage<State> = {
      apply: (state) => state,
      label: "Third",
      questions: () => [question("third", ["done"])],
    };
    const result = await runFormChain([kindStage, extraStage, third], {}, io);

    // The re-asked "extra" form (4th ask) proposes the silver it was answered with.
    expect(seen[3]).toEqual(["silver"]);
    expect(result).toEqual({ kind: "fancy", extra: "silver" });
  });

  it("re-seeds a re-asked free-text answer as the row's draft", async () => {
    const nameStage: ChainStage<State> = {
      apply: (state, answers) => {
        const answer = answers["name"];
        return answer?.kind === "text" ? { ...state, extra: answer.text } : state;
      },
      label: "Name",
      questions: () => [
        {
          freeText: true,
          id: "name",
          kind: "select",
          label: "Name",
          options: [],
          prompt: "Name it",
        },
      ],
    };
    const third: ChainStage<State> = {
      apply: (state) => state,
      label: "Third",
      questions: () => [question("third", ["done"])],
    };
    const seen: (string | undefined)[] = [];
    const base = createScriptedWizardIo({
      forms: [{ name: { kind: "text", text: "codex" } }, "back", {}, {}],
    });
    const io = {
      ...base,
      ask: async (questions: readonly WizardQuestion[]) => {
        seen.push(questions[0]?.initialText);
        return base.ask(questions);
      },
    };

    // name(codex) → back from "third" → name re-asked with the draft seeded.
    await runFormChain([nameStage, third], {}, io);

    expect(seen[2]).toBe("codex");
  });

  it("awaits async stage questions and applies their answers", async () => {
    const asyncExtra: ChainStage<State> = {
      apply: (state, answers) => ({ ...state, extra: selectedValues(answers["extra"])[0] }),
      isApplicable: (state) => state.kind === "fancy",
      label: "Extra",
      questions: (state) =>
        Promise.resolve(
          state.kind === "fancy" ? [question("extra", ["gold", "silver"])] : undefined,
        ),
    };
    const io = createScriptedWizardIo({
      forms: [
        { kind: { kind: "options", values: ["fancy"] } },
        { extra: { kind: "options", values: ["gold"] } },
      ],
    });

    const result = await runFormChain([kindStage, asyncExtra], {}, io);

    expect(result).toEqual({ extra: "gold", kind: "fancy" });
  });

  it("skips an async stage whose resolved questions are empty", async () => {
    const asyncExtra: ChainStage<State> = {
      apply: (state) => state,
      isApplicable: (state) => state.kind === "fancy",
      label: "Extra",
      questions: () => Promise.resolve(undefined),
    };
    const io = createScriptedWizardIo({
      forms: [{ kind: { kind: "options", values: ["plain"] } }],
    });

    const result = await runFormChain([kindStage, asyncExtra], {}, io);

    expect(result).toEqual({ kind: "plain" });
  });
});
