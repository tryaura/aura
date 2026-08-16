import { SETUP_ABORTED, type SetupStep, type SetupStepContext } from "../types.js";
import { selectedValues, type WizardOption } from "../wizard-types.js";

const MANIFEST_VALUE = "manifest";
const SHARED_VALUE = "shared-instructions";

/**
 * The first setup step: put the machine's Aura baseline in place.
 *
 * Offers only what is currently missing — an existing manifest or shared instruction file makes its
 * option disappear rather than show as pre-completed noise, so the fifth run of `setup` asks about
 * exactly as much as it still has to do.
 */
export const baselineStep: SetupStep = {
  gather: async (context, io) => {
    const options = baselineOptions(context);
    if (options.length === 0) {
      io.note("The Aura manifest and shared instructions are already in place.");
      return withBaseline(context, []);
    }

    const result = await io.ask([
      {
        id: "baseline",
        initial: options.map((option) => option.value),
        kind: "multiselect",
        label: "Baseline",
        options,
        prompt: "What should Aura set up on this machine?",
      },
    ]);
    if (result === "aborted") {
      return SETUP_ABORTED;
    }

    return withBaseline(context, selectedValues(result["baseline"]));
  },
  id: "baseline",
  title: "Baseline",
};

function withBaseline(
  context: SetupStepContext,
  values: readonly string[],
): SetupStepContext["selections"] {
  return {
    ...context.selections,
    baseline: {
      createManifest: values.includes(MANIFEST_VALUE),
      createSharedInstructions: values.includes(SHARED_VALUE),
    },
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

  const shared = context.model.sharedInstructions;
  const sharedEmpty = !shared.exists || (shared.content?.trim() ?? "") === "";
  if (shared.problem === undefined && sharedEmpty) {
    options.push({
      description: "One canonical instruction file every agent application links to.",
      label: `Create ${shared.path} from the starter template`,
      value: SHARED_VALUE,
    });
  }

  return options;
}
