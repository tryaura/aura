/**
 * The process capabilities the installer needs and cannot get from an `Environment`.
 *
 * An update happens before a command builds its environment, and needs three things the rest of
 * the CLI never does: a streaming download that follows redirects, the identity of this process
 * so a lock can name its owner, and the ability to ask an executable what version it is. They are
 * an injected interface so every module below stays testable without a network or a fork.
 */

/** One archive download, pinned to a size the release metadata already committed to. */
export interface UpdateDownloadRequest {
  /** File to create. Must not already exist; the installer owns a fresh temporary path. */
  readonly destinationPath: string;
  /** Exact length the release declared. Enforced while streaming and again at the end. */
  readonly expectedBytes: number;
  /** Sent verbatim, and dropped on a cross-origin redirect. May carry a credential. */
  readonly headers: Readonly<Record<string, string>>;
  readonly url: string;
}

/**
 * The outcome of one download.
 *
 * The failure vocabulary is closed rather than error text: a runtime message can echo the request,
 * and the request may carry a credential in its headers.
 */
export type UpdateDownloadResult =
  | { readonly kind: "downloaded"; readonly sha256: string }
  | {
      readonly kind: "failure";
      readonly reason: "insecure-url" | "network" | "too-large" | "unexpected-length";
    };

export interface UpdateHost {
  readonly download: (request: UpdateDownloadRequest) => Promise<UpdateDownloadResult>;
  /**
   * Whether a process id is still running.
   *
   * The stale-lock recovery rests on this: an updater killed mid-transaction leaves a lock behind,
   * and the alternative to asking is either a permanently wedged updater or a timeout short enough
   * to let two of them install at once.
   */
  readonly isProcessAlive: (pid: number) => boolean;
  readonly pid: number;
  /**
   * Runs `<executable> --version` and returns the trimmed single line it printed.
   *
   * `undefined` for any outcome that is not exactly one usable version line. The child receives
   * only the variables passed here, which is how the staged binary is asked its version without
   * letting it start an update of its own.
   */
  readonly probeVersion: (
    executablePath: string,
    environmentVariables: Readonly<Record<string, string>>,
  ) => Promise<string | undefined>;
}
