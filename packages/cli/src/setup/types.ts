import type { AuraManifestState, Finding, Scope, WorkspaceModel } from "@tryaura/aura-sdk";

import type { AppCatalogEntry } from "./catalog.js";
import type { SnippetCatalog } from "./snippets.js";
import type { WizardIo } from "./wizard-types.js";

/** What the apps step decided; see `steps/apps.ts`. */
interface AppSelections {
  /** Adapter ids the user chose to manage, in catalog order. */
  readonly managed: readonly string[];
}

/** What the baseline step decided; see `steps/baseline.ts`. */
interface BaselineSelections {
  readonly createManifest: boolean;
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

/**
 * Everything the wizard has decided so far, one optional slice per step id.
 *
 * A typed record rather than a stringly-keyed map: the planner switches on these exhaustively, and
 * a step that runs alone (AURA-30's `--add`) simply leaves the other slices absent, which the
 * planner resolves as "keep the current state for that concern".
 */
export interface SetupSelections {
  readonly apps?: AppSelections | undefined;
  readonly baseline?: BaselineSelections | undefined;
  readonly instructions?: InstructionSelections | undefined;
  readonly snippets?: SnippetSelections | undefined;
}

export interface SetupStepContext {
  /** Every registered adapter, detected or not, in registry order. */
  readonly appCatalog: readonly AppCatalogEntry[];
  readonly findings?: readonly Finding[] | undefined;
  readonly manifest: AuraManifestState;
  readonly model: WorkspaceModel;
  readonly selections: SetupSelections;
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

type SetupStepOutcome = SetupSelections | typeof SETUP_ABORTED;

/** State another setup step must have established before this one can run by itself. */
interface SetupStepPrerequisite {
  readonly id: string;
  readonly isSatisfied: (context: SetupStepContext) => boolean;
  /** What is missing, in the words a user reads — never the step id. */
  readonly title: string;
}

interface SetupStepBase {
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
