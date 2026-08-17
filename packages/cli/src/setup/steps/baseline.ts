import { SETUP_ABORTED, SETUP_BACK, type SetupStep, type SetupStepContext } from "../types.js";
import { selectedValues, type WizardOption } from "../wizard-types.js";

const MANIFEST_VALUE = "manifest";

/**
 * The setup step that puts the machine's Aura baseline in place.
 *
 * Offers only what is currently missing — an existing manifest makes its option disappear rather
 * than show as pre-completed noise, so the fifth run of `setup` asks about exactly as much as it
 * still has to do. The shared instruction file itself belongs to the instructions step, which is
 * the one that knows whether it is being created from a template or from consolidated sources.
 */
export const baselineStep: SetupStep = {
  gather: async (context, io) => {
    const options = baselineOptions(context);
    if (options.length === 0) {
      if (context.enteredBackward === true) {
        return SETUP_BACK;
      }
      if (context.revisited !== true) {
        io.note("The Aura manifest is already in place.");
      }
      return withBaseline(context, []);
    }

    const result = await io.ask([
      {
        compactLabel: "Base",
        id: "baseline",
        // A re-entered step shows the answer this run already gave it, not its cold-start proposal.
        initial:
          context.selections.baseline === undefined
            ? options.map((option) => option.value)
            : options
                .map((option) => option.value)
                .filter(
                  (value) =>
                    value !== MANIFEST_VALUE ||
                    context.selections.baseline?.createManifest === true,
                ),
        kind: "multiselect",
        label: "Baseline",
        options,
        prompt: "What should Aura set up on this machine?",
      },
    ]);
    if (result === "aborted") {
      return SETUP_ABORTED;
    }
    if (result === "back") {
      return SETUP_BACK;
    }

    return withBaseline(context, selectedValues(result["baseline"]));
  },
  compactTitle: "Base",
  id: "baseline",
  title: "Baseline",
};

function withBaseline(
  context: SetupStepContext,
  values: readonly string[],
): SetupStepContext["selections"] {
  return {
    ...context.selections,
    baseline: { createManifest: values.includes(MANIFEST_VALUE) },
  };
}

function baselineOptions(context: SetupStepContext): readonly WizardOption[] {
  const options: WizardOption[] = [];

  if (context.manifest.status === "missing") {
    options.push({
      description: "Aura's record of what it manages; future runs converge against it.",
      label: `Create ${context.manifest.path}`,
      value: MANIFEST_VALUE,
    });
  }

  return options;
}
