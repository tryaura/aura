import type { Fixability, JsonObject, Scope, Severity } from "./common.js";
import type { FixPlan } from "./fix.js";
import type { WorkspaceModel } from "./model.js";

/** Where in a file a finding applies. */
export interface FindingLocation {
  /** 1-based column. */
  readonly column?: number | undefined;
  /** 1-based line. */
  readonly line?: number | undefined;
  /** Absolute path. */
  readonly path: string;
}

/** How a metadata-table column should render its values in human output. */
export type FindingMetadataColumnFormat = "boolean" | "integer" | "percentage" | "text";

/** What every metadata-table column declares, whatever it holds. */
interface FindingMetadataColumnBase {
  /** Aligns the rendered cell within the column. */
  readonly align?: "left" | "right" | undefined;
  /** User-facing column heading. */
  readonly heading: string;
  /** Object key read from every metadata row. */
  readonly key: string;
}

/** A column of booleans, rendered as labels rather than as `true` and `false`. */
export interface FindingMetadataBooleanColumn extends FindingMetadataColumnBase {
  /** Text used when the value is false. Defaults to `false`. */
  readonly falseLabel?: string | undefined;
  readonly format: "boolean";
  /** Text used when the value is true. Defaults to `true`. */
  readonly trueLabel?: string | undefined;
}

/**
 * A column formatted straight from its value.
 *
 * The label fields are declared as `never` so that a column carrying them without asking for
 * `"boolean"` fails to compile rather than passing labels the renderer will never read.
 */
export interface FindingMetadataValueColumn extends FindingMetadataColumnBase {
  readonly falseLabel?: never;
  /** Converts the JSON value into human-readable text. Defaults to `"text"`. */
  readonly format?: Exclude<FindingMetadataColumnFormat, "boolean"> | undefined;
  readonly trueLabel?: never;
}

/** One column in a generic table backed by finding metadata. Discriminate on `format`. */
export type FindingMetadataTableColumn = FindingMetadataBooleanColumn | FindingMetadataValueColumn;

/** A generic request for the CLI to render one metadata array as a table. */
export interface FindingMetadataTablePresentation {
  readonly columns: readonly FindingMetadataTableColumn[];
  readonly kind: "metadata-table";
  /** Top-level key of the array in {@link DetectedFinding.metadata}. */
  readonly rowsKey: string;
}

/** Optional human-output presentation attached to a finding. */
export type FindingPresentation = FindingMetadataTablePresentation;

/**
 * What a {@link Check} emits for one problem it found.
 *
 * The check's own `id`, `scope`, and `defaultSeverity` are stamped on by Aura core, so a finding
 * cannot contradict the check that produced it.
 */
export interface DetectedFinding {
  /** Extra explanation for this occurrence, beyond the check's static {@link Check.explain}. */
  readonly details?: string | undefined;
  /**
   * Stable identifier for this occurrence, unique across runs.
   *
   * Derive it from what the finding is about — a path, an app id — never from array position, so
   * that suppressions survive unrelated changes.
   */
  readonly id: string;
  /** Where the problem is, when it maps to specific files. */
  readonly locations?: readonly FindingLocation[] | undefined;
  /** One sentence naming the problem, in terms the user can act on. */
  readonly message: string;
  /**
   * Structured detail for machine-readable output.
   *
   * Rendered in user-visible output. Never place credentials or file contents here.
   */
  readonly metadata?: JsonObject | undefined;
  /** Generic guidance for presenting the structured metadata in human output. */
  readonly presentation?: FindingPresentation | undefined;
  /** Overrides {@link Check.defaultSeverity} for this occurrence only. */
  readonly severity?: Severity | undefined;
}

/** A {@link DetectedFinding} after Aura core has stamped on its check's identity. */
export interface Finding extends DetectedFinding {
  /** The {@link Check.id} that produced this finding. */
  readonly checkId: string;
  /** The producing check's {@link Check.scope}. */
  readonly scope: Scope;
  /** The resolved severity: the finding's own, or the check's {@link Check.defaultSeverity}. */
  readonly severity: Severity;
}

/**
 * One rule evaluated against the normalized workspace.
 *
 * Checks are synchronous and pure. They receive the whole {@link WorkspaceModel} and must not read
 * the filesystem, spawn processes, inspect `process.env`, or make network requests — everything
 * Aura knows is already in the model. This is what makes a run reproducible and lets Aura report
 * every check from a single scan.
 */
interface CheckDefinition {
  /** Severity for findings that do not override it. */
  readonly defaultSeverity: Severity;
  /** Returns one finding per problem, or an empty array when the rule is satisfied. */
  readonly detect: (model: WorkspaceModel) => readonly DetectedFinding[];
  /** Why the rule exists, in one or two sentences. Shown when a user asks about a finding. */
  readonly explain: string;
  /** Stable check identifier, namespaced by the owning {@link AuraPlugin.id}. */
  readonly id: string;
  /** Whether the rule is about user-level or workspace-level state. */
  readonly scope: Scope;
  /** Short imperative statement of the desired state, such as `"Shared instructions exist"`. */
  readonly title: string;
}

interface FixableCheck extends CheckDefinition {
  /**
   * Builds the remediation for one finding.
   *
   * Returns data only; Aura core applies it. Return `undefined` when this particular finding
   * cannot be fixed automatically, even though the check declares itself fixable.
   */
  readonly fix: (finding: Finding, model: WorkspaceModel) => FixPlan | undefined;
  /** Whether the returned remediation is complete or includes manual steps. */
  readonly fixability: Exclude<Fixability, "manual">;
}

interface ManualCheck extends CheckDefinition {
  /** Manual checks cannot provide an executable remediation. */
  readonly fix?: undefined;
  /** The remediation must be completed manually. */
  readonly fixability: "manual";
}

/** One rule evaluated against the normalized workspace, with its remediation contract enforced. */
export type Check = FixableCheck | ManualCheck;
