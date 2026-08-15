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
  /** One sentence naming the problem, in terms the user can act on. */
  readonly message: string;
  /** The path involved, when the problem is about one. */
  readonly path?: string | undefined;
  /** Where in the scan it happened. */
  readonly phase: ScanPhase;
}
