import { describe, expect, it } from "vitest";

import { renderWizardFrame, type WizardFrame } from "../wizard-render.js";
import { runFormChain } from "../wizard-chain.js";
import { createScriptedWizardIo } from "../wizard-scripted.js";
import type {
  WizardAnswers,
  WizardFlowContext,
  WizardIo,
  WizardQuestion,
} from "../wizard-types.js";
import {
  CONSOLIDATE_VALUE,
  scopeStages,
  TEMPLATE_VALUE,
  type ChainState,
  type ScopeInput,
} from "./instruction-stages.js";

const GLOBAL: ScopeInput = {
  blocked: false,
  clusters: [],
  scope: "global",
  sources: [
    { content: "# Claude\n\nGlobal.\n", path: "/home/dev/.claude/CLAUDE.md", scope: "global" },
  ],
  targetContentValue: undefined,
  targetPath: "/home/dev/agents/AGENTS.md",
};

const FLOW: WizardFlowContext = {
  completed: [{ label: "Applications" }],
  step: { compactLabel: "Instr", label: "Instructions" },
  upcoming: [{ compactLabel: "Base", label: "Baseline" }],
};

interface Ask {
  readonly flow: WizardFlowContext | undefined;
  readonly ids: readonly string[];
  readonly questions: readonly WizardQuestion[];
}

/** Runs the personal stages, recording every form the chain opened and the flow it carried. */
async function runStages(
  answer: WizardAnswers,
): Promise<{ readonly asks: readonly Ask[]; readonly state: ChainState }> {
  const asks: Ask[] = [];
  const base = createScriptedWizardIo({ forms: Array.from({ length: 8 }, () => answer) });
  const io: WizardIo = {
    ...base,
    ask: async (questions, flow) => {
      asks.push({ flow, ids: questions.map((question) => question.id), questions });
      return base.ask(questions, flow);
    },
  };

  const state = await runFormChain(scopeStages(GLOBAL), { global: {} }, io, { flow: FLOW });
  if (typeof state === "symbol") {
    throw new Error("Expected the chain to settle.");
  }
  return { asks, state };
}

/** The action form one scope opens with, before any answer has been given to it. */
async function actionQuestion(input: ScopeInput): Promise<WizardQuestion> {
  const question = (await scopeStages(input)[0]?.questions({ global: {} }))?.[0];
  if (question?.kind !== "select") {
    throw new Error("Expected the action form.");
  }
  return question;
}

describe("scopeStages", () => {
  it("ends personal configuration after sources when it has no duplicates to review", async () => {
    const { asks, state } = await runStages({});

    expect(state.global.action).toBe("consolidate");
    expect(asks.map((ask) => ask.ids)).toEqual([
      ["global-instruction-action"],
      ["global-instruction-sources"],
    ]);
  });

  it("asks nothing for a scope whose target is already the only instruction file", () => {
    // Both answers such a menu could carry are no decisions: `keep` changes nothing, and the
    // starter template overwrites text Aura did not write. The scope contributes no tabs at all.
    expect(
      scopeStages({ ...GLOBAL, sources: [], targetContentValue: "# Hand written\n\nKeep this.\n" }),
    ).toEqual([]);
    // Still asked while either half of that holds: a source to merge, or an empty target.
    expect(scopeStages({ ...GLOBAL, targetContentValue: "# Hand written\n" })).not.toEqual([]);
    expect(scopeStages({ ...GLOBAL, sources: [], targetContentValue: "  \n" })).not.toEqual([]);
  });

  it("leads the menu with the recommended answer, marked, even where a target exists to keep", async () => {
    const question = await actionQuestion({ ...GLOBAL, targetContentValue: "# Hand written\n" });

    // Combining is hoisted over `keep`, which the build order puts first; everything under it
    // stays in that order.
    expect(question.options.map((option) => option.value)).toEqual([
      CONSOLIDATE_VALUE,
      "keep",
      TEMPLATE_VALUE,
    ]);
    // What `--yes` takes, what a missing answer falls back to, and what wears the label — one row.
    expect(question.initial).toEqual([CONSOLIDATE_VALUE]);
    expect(question.options.filter((option) => option.recommended === true)).toHaveLength(1);

    const frame: WizardFrame = {
      activeTab: 0,
      cursorRow: 0,
      questions: [{ answered: false, question, selected: new Set([CONSOLIDATE_VALUE]), text: "" }],
    };
    const rows = renderWizardFrame(frame, 0).split("\n");

    expect(rows).toContain("❯ 1. ● Combine found instructions (Recommended)");
    expect(rows).toContain("  2. ○ Keep existing shared file");
  });

  it("keeps the recommendation off a scope with nothing to combine", async () => {
    // Nothing to combine leaves the leading row standing, and no row claims to be recommended:
    // the label is advice about combining, not decoration on whichever row happens to be proposed.
    const question = await actionQuestion({ ...GLOBAL, sources: [], targetContentValue: "" });

    expect(question.initial).toEqual([TEMPLATE_VALUE]);
    expect(question.options.some((option) => option.recommended === true)).toBe(false);
  });

  it("says on the action menu that combining moves the files it merges", async () => {
    const { asks } = await runStages({});

    const action = asks[0]?.questions[0];
    if (action?.kind !== "select") {
      throw new Error("Expected the global action form.");
    }
    expect(action.options.find((option) => option.value === "consolidate")?.description).toBe(
      "Move instructions from the files you select into this AGENTS.md file. Aura backs up the originals for undo.",
    );
  });
});
