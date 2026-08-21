/**
 * How an application treats `@path` references written inside instruction files.
 *
 * `"at-import"` means a reference activates a load: the referenced file joins the application's
 * context, as Claude Code's `@` imports do. `"none"` means the application reads such references
 * as prose, so a check must not promise that a linked file is ever loaded.
 */
export type AdapterImportStyle = "at-import" | "none";

/**
 * Which of an adapter's declared instruction files the application loads into context.
 *
 * `"all-files"`: every instruction file the adapter models is loaded whenever the application
 * runs, as Codex loads its `AGENTS.md` chain. `"import-graph"`: the declared files are roots, and
 * what actually loads is the graph reachable from them through activating imports.
 */
export type AdapterInstructionLoading = "all-files" | "import-graph";

/** Declarative facts about how the application loads instruction files. */
export interface AdapterInstructionCapabilities {
  /**
   * Whether linking the global shared-instruction source is meaningful for this application.
   *
   * Declare `"not-applicable"` only when the application exposes no global instruction file Aura
   * can write, such as guidance stored inside application settings. When omitted, checks preserve
   * the legacy fallback and report a missing `Adapter.sharedLink` as manual work.
   */
  readonly globalSharedLink?: "not-applicable" | undefined;
  /**
   * How many import hops the application follows before it stops loading.
   *
   * Meaningful only alongside `importStyle: "at-import"`. When omitted, checks treat chains as
   * followed however far they go.
   */
  readonly importDepthLimit?: number | undefined;
  /** How `@` references behave. When omitted, checks assume references activate (`"at-import"`). */
  readonly importStyle?: AdapterImportStyle | undefined;
  /**
   * How declared instruction files reach the context window.
   *
   * When omitted, Aura does not model this application's loading: checks that reason about what is
   * actually loaded treat its instruction totals as an unverified upper bound instead.
   */
  readonly loading?: AdapterInstructionLoading | undefined;
}

/** One application directory that consumes Agent Skills. */
export interface AdapterSkillDirectory {
  /** Stable source-file id used by the adapter's read side. */
  readonly id: string;
  /** Portable global `~/...` path resolved from the captured home directory. */
  readonly entryPath: string;
}

/** Declarative Agent Skills support for one application. */
export interface AdapterSkillCapabilities {
  readonly directories: readonly AdapterSkillDirectory[];
}

/**
 * Facts an adapter declares about its application, read by checks instead of per-adapter tables.
 *
 * Every field is optional, and each documents the fallback a check applies when it is omitted —
 * the same behavior checks used before adapters could declare these. A third-party adapter that
 * declares nothing here loses precision, not correctness.
 */
export interface AdapterCapabilities {
  /** How the application loads instruction files. */
  readonly instructions?: AdapterInstructionCapabilities | undefined;
  /** Where this application discovers Agent Skills; omission means unsupported. */
  readonly skills?: AdapterSkillCapabilities | undefined;
}
