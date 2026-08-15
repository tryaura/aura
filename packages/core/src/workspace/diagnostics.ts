/** The stage of a scan that produced a {@link ScanDiagnostic}. */
export type ScanPhase = "detect" | "files" | "parse" | "read" | "support";

/**
 * A problem core hit while scanning, reported alongside the model rather than inside it.
 *
 * {@link WorkspaceModel} describes the machine; these describe the scan itself — an adapter that
 * threw, a required path that was missing. Keeping them out of the model means checks stay pure
 * functions over the machine's state and never have to reason about how well the scan went.
 */
export interface ScanDiagnostic {
  /** The {@link Adapter.id} whose scan produced this. */
  readonly adapterId: string;
  /**
   * Verbatim text from the plugin that failed, when there is any.
   *
   * Untrusted, and potentially secret. Plugin errors quote the input that broke them — `JSON.parse`
   * echoes the bytes it choked on — and the files Aura reads are the ones holding API tokens. This
   * is for opt-in debug output; never render it in the default report.
   */
  readonly detail?: string | undefined;
  /** One sentence naming the problem, in terms the user can act on. */
  readonly message: string;
  /** The path involved, when the problem is about one. */
  readonly path?: string | undefined;
  /** Where in the scan it happened. */
  readonly phase: ScanPhase;
}

/** How much of a plugin's error text is kept, before it stops being a diagnostic and starts being a dump. */
const MAX_DETAIL_CHARACTERS = 500;

/**
 * Reduces a thrown value to the `detail` of a diagnostic.
 *
 * The text stays out of the diagnostic's `message` because it is untrusted: `JSON.parse` quotes the
 * bytes it choked on, and the files Aura reads are the ones that hold API tokens. Interpolating it
 * into a message would print a secret in the default report.
 */
export function describeFailure(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);

  return reason.length > MAX_DETAIL_CHARACTERS
    ? `${reason.slice(0, MAX_DETAIL_CHARACTERS)}…`
    : reason;
}
