import type { CliUpdates } from "@tryaura/aura-cli";

/**
 * Where `acmedev` looks for a newer release.
 *
 * A private GitHub Enterprise Server repository, which is the common shape for a distribution that
 * is already released through the company's own GitHub. The token is named, never embedded: a
 * build-time constant would ship one reusable credential inside every copy of the executable, and
 * a read-only Contents token is the smallest thing that can fetch a private release.
 *
 * Immutable releases are mandatory. A server that cannot promise them should use the
 * `signed-manifest` source instead.
 */
export const ACME_UPDATES: CliUpdates = {
  apiBaseUrl: "https://ghe.acme.example/api/v3",
  kind: "github-release",
  manualUpdateUrl: "https://ghe.acme.example/platform/acmedev/releases/latest",
  owner: "platform",
  repository: "acmedev",
  tokenEnvironmentVariable: "ACMEDEV_RELEASE_TOKEN",
};
