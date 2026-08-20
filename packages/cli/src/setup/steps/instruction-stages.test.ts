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
import { scopeStages, SKIP_VALUE, type ChainState, type ScopeInput } from "./instruction-stages.js";

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

const PROJECT: ScopeInput = {
  blocked: false,
  clusters: [],
  scope: "project",
  sources: [{ content: "# Project\n\nRules.\n", path: "/work/CLAUDE.md", scope: "project" }],
  targetContentValue: undefined,
  targetPath: "/work/AGENTS.md",
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

/** Runs both scopes' stages, recording every form the chain opened and the flow it carried. */
async function runScopes(
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

  const state = await runFormChain(
    [...scopeStages(GLOBAL), ...scopeStages(PROJECT)],
    { global: {}, project: {} },
    io,
    { flow: FLOW },
  );
  if (typeof state === "symbol") {
    throw new Error("Expected the chain to settle.");
  }
  return { asks, state };
}

describe("scopeStages", () => {
  it("gives a declined scope its action tab and nothing after it", async () => {
    const { asks, state } = await runScopes({
      "project-instruction-action": { kind: "options", values: [SKIP_VALUE] },
    });

    expect(state.project.action).toBe(SKIP_VALUE);
    // No Sources or Duplicates form follows the declined scope — the sub-row maps what exists, so
    // tabs the answer removed must not be left standing in it.
    expect(asks.map((ask) => ask.ids)).toEqual([
      ["global-instruction-action"],
      ["global-instruction-sources"],
      ["project-instruction-action"],
    ]);

    const declined = asks.at(-1);
    const question = declined?.questions[0];
    if (declined === undefined || question === undefined) {
      throw new Error("Expected the project action form.");
    }
    const frame: WizardFrame = {
      activeTab: 0,
      cursorRow: 0,
      ...(declined.flow === undefined ? {} : { flow: declined.flow }),
      questions: [{ answered: false, question, selected: new Set(), text: "" }],
    };

    // The row `docs/cli-ux.md` pins for a declined scope, rendered from the chain that produces it.
    expect(renderWizardFrame(frame, 0).split("\n")[1]).toBe(
      " └ ✔ Global │ ✔ Sources │ ▶ Project ☐",
    );
  });

  it("ends each configured scope after its sources when it has no duplicates to review", async () => {
    const { asks, state } = await runScopes({});

    expect(state.project.action).toBe("consolidate");
    expect(asks.map((ask) => ask.ids)).toEqual([
      ["global-instruction-action"],
      ["global-instruction-sources"],
      ["project-instruction-action"],
      ["project-instruction-sources"],
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

  it("says on the action menu that combining moves the files it merges", async () => {
    const { asks } = await runScopes({});

    const action = asks[0]?.questions[0];
    if (action?.kind !== "select") {
      throw new Error("Expected the global action form.");
    }
    expect(action.options.find((option) => option.value === "consolidate")?.description).toBe(
      "Move instructions from the files you select into this AGENTS.md file. Aura backs up the originals for undo.",
    );
  });
});
