import type {
  AuraManifestSkill,
  AuraManifestState,
  Finding,
  ResolvedSkillPack,
  Scope,
  WorkspaceModel,
} from "@tryaura/aura-sdk";

import type { AppCatalogEntry } from "./catalog.js";
import type { SkillCatalog } from "./skills-catalog.js";
import type { SnippetCatalog } from "./snippets.js";
import type { WizardFlowContext, WizardIo } from "./wizard-types.js";

/** What the apps step decided; see `steps/apps.ts`. */
interface AppSelections {
  /** Adapter ids the user chose to manage, in catalog order. */
  readonly managed: readonly string[];
}

/** What the baseline step decided; see `steps/baseline.ts`. */
interface BaselineSelections {
  readonly createManifest: boolean;
  /** Raw option values as chosen, so a re-entered form re-seeds exactly what was answered. */
  readonly selected: readonly string[];
}

/**
 * What the wizard settled on for one scope.
 *
 * `blocked` is not `keep`: it means Aura could not read the target safely, so the scope is left out
 * of link planning entirely rather than wired to a file Aura refused to touch.
 */
type InstructionTargetAction = "blocked" | "consolidate" | "keep" | "template";

export interface InstructionScopeSelection {
  readonly action: InstructionTargetAction;
  readonly archiveOriginals: boolean;
  /** INS-003 finding id to selected `path:startLine:endLine` member id. */
  readonly duplicateWinners: Readonly<Record<string, string>>;
  readonly scope: Scope;
  readonly selectedSources: readonly string[];
  readonly targetPath: string;
}

interface InstructionSelections {
  readonly global: InstructionScopeSelection;
  readonly project?: InstructionScopeSelection | undefined;
}

interface SnippetSelections {
  /** Available selected ids in picker order, followed by locked unavailable selections. */
  readonly selected: readonly string[];
}

export interface SkillSelection {
  readonly id: string;
  readonly source: AuraManifestSkill["source"];
}

interface SkillSelections {
  /** Private directories explicitly approved for credential-bearing requests during this run. */
  readonly approvedPrivateSourceIds?: readonly string[] | undefined;
  /**
   * Directory packs fetched and reviewed during the step, keyed into the plan by identity.
   *
   * The scan stays offline, so remote packs never appear in `model.availableSkills`; this is how
   * they reach the planner. A selected directory skill without a pack here keeps its previous
   * manifest entry untouched — which is exactly what "reviewed Skip" and "offline" should do.
   */
  readonly resolved?: readonly ResolvedSkillPack[] | undefined;
  readonly selected: readonly SkillSelection[];
}

/**
 * Everything the wizard has decided so far, one optional slice per step id.
 *
 * A typed record rather than a stringly-keyed map: the planner switches on these exhaustively, and
 * a step that runs alone (via `--add`) simply leaves the other slices absent, which the
 * planner resolves as "keep the current state for that concern".
 */
export interface SetupSelections {
  readonly apps?: AppSelections | undefined;
  readonly baseline?: BaselineSelections | undefined;
  readonly instructions?: InstructionSelections | undefined;
  readonly snippets?: SnippetSelections | undefined;
  readonly skills?: SkillSelections | undefined;
}

export interface SetupStepContext {
  /** Every registered adapter, detected or not, in registry order. */
  readonly appCatalog: readonly AppCatalogEntry[];
  /**
   * True when the user navigated ← into this step from the one after it. The step then opens on
   * its last form, and a step with nothing to ask returns {@link SETUP_BACK} so ← keeps walking.
   */
  readonly enteredBackward?: boolean | undefined;
  /** Where this step sits in the wizard flow; chain steps hand it to `runFormChain` for sub-tabs. */
  readonly flow?: WizardFlowContext | undefined;
  /** True when this step already ran earlier in this run; informational banners stay quiet. */
  readonly revisited?: boolean | undefined;
  readonly findings?: readonly Finding[] | undefined;
  readonly manifest: AuraManifestState;
  readonly model: WorkspaceModel;
  readonly selections: SetupSelections;
  /**
   * The skills the run can install, fetched on first use.
   *
   * Only the skills step lists or resolves; the planner reads back the packs that step fetched and
   * the policy the catalog carries, and never awaits anything.
   */
  readonly skillCatalog: SkillCatalog;
  /**
   * The registry's snippets, read on first use.
   *
   * Only the snippets step needs the bodies, so nothing is read until it runs; the planner reads
   * back what that step resolved, and skips the whole catalog when the step did not run.
   */
  readonly snippetCatalog: SnippetCatalog;
}

/** The out-of-band outcome of a step the user backed out of. */
export const SETUP_ABORTED: unique symbol = Symbol("aura.setup.aborted");

/** The user navigated ← past the step's first form; the orchestrator re-runs the previous step. */
export const SETUP_BACK: unique symbol = Symbol("aura.setup.back");

type SetupStepOutcome = SetupSelections | typeof SETUP_ABORTED | typeof SETUP_BACK;

/** State another setup step must have established before this one can run by itself. */
interface SetupStepPrerequisite {
  readonly id: string;
  readonly isSatisfied: (context: SetupStepContext) => boolean;
  /** What is missing, in the words a user reads — never the step id. */
  readonly title: string;
}

interface SetupStepBase {
  /** Shorter tab-bar title used when the full flow would overflow the terminal. */
  readonly compactTitle?: string | undefined;
  readonly gather: (context: SetupStepContext, io: WizardIo) => Promise<SetupStepOutcome>;
  readonly id: string;
  /**
   * Whether this step reads {@link SetupStepContext.findings}.
   *
   * Producing them means running every check up front, and the duplicate scan among them is
   * quadratic in the paragraphs it compares. A run that selected no step needing findings — `setup
   * --add snippet`, for one — should not pay for a scan nothing reads.
   */
  readonly needsFindings?: boolean | undefined;
  readonly title: string;
}

/**
 * Whether a step can be named by `setup --add`, and what it needs when it is.
 *
 * Opting into standalone execution forces the question "against what state?" to be answered: a step
 * that declares `addKind` must also say what must already exist, even if the answer is the empty
 * list. Without the pairing a future step could take `--add` and run unguarded against a machine
 * the full setup has never touched.
 */
type SetupStepStandalone =
  | {
      readonly addKind?: undefined;
      /** Prior steps whose result must exist either in this run or in the observed machine state. */
      readonly prerequisites?: readonly SetupStepPrerequisite[] | undefined;
    }
  | {
      /** Public singular name accepted by `setup --add`. */
      readonly addKind: string;
      readonly prerequisites: readonly SetupStepPrerequisite[];
    };

/**
 * One wizard step.
 *
 * `gather` prompts through `io` and returns the selections extended with its own slice — it never
 * touches the filesystem. All writing happens once, after the last step, through a single fix plan;
 * that is what makes "abort at any step leaves the machine untouched" structural rather than
 * something each step has to get right.
 */
export type SetupStep = SetupStepBase & SetupStepStandalone;
