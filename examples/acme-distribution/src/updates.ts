import type { CliUpdates } from "@tryaura/aura-cli";

/**
 * Where `acmedev` looks for a newer release.
 *
 * A private GitHub Enterprise Server repository, which is the common shape for a distribution that
 * is already released through the company's own GitHub. The token is named, never embedded: a
 * build-time constant would ship one reusable credential inside every copy of the executable, and
 * a read-only Contents token is the smallest thing that can fetch a private release.
 *
 * `requireImmutable` stays true. The digest this updater verifies against comes from the release
 * metadata, and it is only worth verifying if that release cannot be republished with other bytes.
 * A server that cannot promise this should use the `signed-manifest` source instead.
 */
export const ACME_UPDATES: CliUpdates = {
  disableEnvironmentVariable: "ACMEDEV_UPDATE",
  manualUpdateUrl: "https://ghe.acme.example/platform/acmedev/releases/latest",
  source: {
    apiBaseUrl: "https://ghe.acme.example/api/v3",
    kind: "github-release",
    owner: "platform",
    repository: "acmedev",
    requireImmutable: true,
    tokenEnvironmentVariable: "ACMEDEV_RELEASE_TOKEN",
  },
};
