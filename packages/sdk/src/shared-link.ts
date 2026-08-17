/** Placeholder an adapter uses inside a shared-instruction link template. */
export const SHARED_INSTRUCTIONS_TEMPLATE_TOKEN = "{{sharedInstructions}}";

/** How Aura wires an application's instruction entry point to the shared source. */
export type AdapterSharedLinkKind = "import-line" | "native-copy" | "symlink";

/** Fields every shared-link declaration carries, whatever its kind. */
interface AdapterSharedLinkBase {
  /**
   * Application entry path. `~/...` resolves from home; `./...` resolves from the workspace cwd.
   */
  readonly entryPath: string;
}

/**
 * A shared link materialized as a symbolic link.
 *
 * The entry path points at the shared source directly, so there is no content to write.
 * `lineTemplate` is declared `never` rather than merely omitted, so a declaration that pairs a
 * template with `symlink` fails to compile instead of shipping a template core would never read.
 */
export interface AdapterSymlinkSharedLink extends AdapterSharedLinkBase {
  /** How core should materialize the link. */
  readonly kind: "symlink";
  readonly lineTemplate?: never;
}

/** A shared link written as content: an import line or a wrapper file the application reads. */
export interface AdapterContentSharedLink extends AdapterSharedLinkBase {
  /** How core should materialize the link. */
  readonly kind: Exclude<AdapterSharedLinkKind, "symlink">;
  /**
   * Content to reconcile or write, containing exactly one
   * {@link SHARED_INSTRUCTIONS_TEMPLATE_TOKEN}.
   */
  readonly lineTemplate: string;
}

/**
 * Declarative write-side support for linking one application to Aura's shared instructions.
 *
 * A discriminated union on `kind`: content-bearing links require `lineTemplate` and a symlink
 * refuses one, so the illegal combinations are unrepresentable rather than prose rules. Core still
 * re-checks the same rules at registry time for plugins that ship as compiled JavaScript.
 */
export type AdapterSharedLink = AdapterContentSharedLink | AdapterSymlinkSharedLink;
