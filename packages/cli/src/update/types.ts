/**
 * The public update contract.
 *
 * A standalone entry point declares its update source at build time. Package-manager entry points
 * call `runCli` instead, so they cannot reach installation code however they were invoked.
 */

/** Release targets the updater knows how to name, download, and install. */
export type UpdateTarget = "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64";

/** Where one distribution's standalone releases come from. */
export type CliUpdates = {
  /**
   * Page a user is pointed at when an update was found but could not be installed.
   *
   * Falls back to {@link CliBranding.docsUrl}; when neither exists the warning simply omits the
   * link rather than inventing one.
   */
  readonly manualUpdateUrl?: string | undefined;
  /** Variable holding a credential for private release metadata and same-origin assets. */
  readonly tokenEnvironmentVariable?: string | undefined;
} & (
  | {
      /** API root. Defaults to `https://api.github.com`. */
      readonly apiBaseUrl?: string | undefined;
      readonly kind: "github-release";
      readonly owner: string;
      readonly repository: string;
    }
  | {
      readonly kind: "signed-manifest";
      readonly manifestUrl: string;
      /** Base64 Ed25519 public keys, 32 raw bytes each. */
      readonly trustedPublicKeys: readonly string[];
    }
);

/**
 * One release, fully validated and pinned.
 *
 * A provider returns this only after narrowing every field of an unknown response. The URL is
 * pinned to the selected release rather than a moving "latest" path, so a publication race cannot
 * change the bytes behind a digest that has already been accepted.
 */
export interface UpdateCandidate {
  readonly downloadUrl: string;
  /** 64 lowercase hexadecimal characters. */
  readonly sha256: string;
  readonly size: number;
  readonly version: string;
}
