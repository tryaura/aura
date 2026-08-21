import type { CliUpdates } from "@tryaura/aura-cli";

/**
 * The official Aura binary's update policy, frozen at build time.
 *
 * The repository is a literal, not configuration. A distribution that could be pointed somewhere
 * else — by a variable, a config file, or a preset — would let anything that can write to a user's
 * environment choose which executable replaces the one on their path.
 *
 * Immutability is required rather than preferred. GitHub's per-asset SHA-256 digest is only worth
 * verifying against if the release it came from cannot be republished with different bytes, and a
 * mutable release is exactly the case where the digest and the download disagree later.
 */
export const AURA_UPDATES: CliUpdates = {
  disableEnvironmentVariable: "AURA_UPDATE",
  manualUpdateUrl: "https://github.com/tryaura/aura/releases/latest",
  source: {
    apiBaseUrl: "https://api.github.com",
    kind: "github-release",
    owner: "tryaura",
    // Public releases download without authentication, so the official binary names no token
    // variable at all: there is nothing for a hostile environment to make it send.
    repository: "aura",
    requireImmutable: true,
  },
};
