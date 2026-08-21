/**
 * The public update contract.
 *
 * Two independent gates guard the installer, and both live here as types. A distribution declares
 * {@link CliUpdates} at build time; the process boundary that compiled a standalone executable
 * supplies {@link CliStandaloneInstallation} at run time. A package-manager entry point supplies
 * neither, so it cannot reach installation code however it was invoked.
 */

/** Release targets the updater knows how to name, download, and install. */
export type CliUpdateTarget = "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64";

/** Where one distribution's standalone releases come from, and how a user turns updates off. */
export interface CliUpdates {
  /**
   * Variable a user sets to `off` to stop startup updates for this distribution.
   *
   * Distribution-specific on purpose: an enterprise build must not be silenced by a variable an
   * unrelated product owns, and the official binary must not be silenced by an enterprise one.
   */
  readonly disableEnvironmentVariable: string;
  /**
   * Page a user is pointed at when an update was found but could not be installed.
   *
   * Falls back to {@link CliBranding.docsUrl}; when neither exists the warning simply omits the
   * link rather than inventing one.
   */
  readonly manualUpdateUrl?: string | undefined;
  readonly source: CliUpdateSource;
}

/**
 * A release source.
 *
 * Both variants name their credential by variable rather than carrying one: a build-time constant
 * would ship a reusable token inside every copy of the executable.
 */
export type CliUpdateSource =
  | {
      /** API root, `https://api.github.com` for github.com and `https://<host>/api/v3` for GHES. */
      readonly apiBaseUrl: string;
      readonly kind: "github-release";
      readonly owner: string;
      readonly repository: string;
      /**
       * Whether the release must be immutable.
       *
       * The official source requires it. A server that cannot report immutability and per-asset
       * SHA-256 digests must use `signed-manifest` rather than relax the shared installer.
       */
      readonly requireImmutable: boolean;
      /** Variable holding a token with repository Contents read permission, and nothing more. */
      readonly tokenEnvironmentVariable?: string | undefined;
    }
  | {
      readonly kind: "signed-manifest";
      readonly manifestUrl: string;
      readonly tokenEnvironmentVariable?: string | undefined;
      /**
       * Base64 Ed25519 public keys, 32 raw bytes each.
       *
       * More than one is allowed so a release signed by the outgoing key can distribute a binary
       * that already trusts its replacement, which is what makes rotation possible at all.
       */
      readonly trustedPublicKeys: readonly string[];
    };

/**
 * The standalone executable this process is running as.
 *
 * Supplied only by a compiled distribution's own entry point. Ownership is declared, never
 * inferred: no `npm_execpath`, `PATH`, or command-name heuristic can conjure this value, so an
 * `npx` or npm-global run has no way to reach the installer.
 */
export interface CliStandaloneInstallation {
  readonly architecture: "arm64" | "x64";
  /** Absolute path of the running executable, which the installer replaces in place. */
  readonly executablePath: string;
  readonly kind: "standalone";
  readonly platform: "darwin" | "linux";
}

/**
 * One release, fully validated and pinned.
 *
 * A provider returns this only after narrowing every field of an unknown response. The URL is
 * pinned to the selected release rather than a moving "latest" path, so a publication race cannot
 * change the bytes behind a digest that has already been accepted.
 */
export interface CliUpdateCandidate {
  readonly archive: {
    readonly downloadUrl: string;
    /** 64 lowercase hexadecimal characters. */
    readonly sha256: string;
    readonly size: number;
  };
  readonly version: string;
}
