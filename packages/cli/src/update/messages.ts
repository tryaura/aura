import type { CliBranding } from "../types.js";

/**
 * Everything the updater says, and it says very little.
 *
 * A user who ran `aura check` asked about their repository, not about Aura. Two lines is the whole
 * budget for a successful update; a failure gets one line and a place to go. Nothing is printed
 * for a check that found nothing, failed to reach the network, or lost a lock — those are not
 * events in the user's day.
 */

/** Announced before the download starts, because the wait is otherwise unexplained. */
export function updatingLine(branding: CliBranding, from: string, to: string): string {
  return `Updating ${branding.displayName} ${from} -> ${to}...\n`;
}

/**
 * The success line, which says plainly that this run is not the updated one.
 *
 * The process already running keeps its own in-memory image. Claiming otherwise would send someone
 * to check `--version` and find the old number.
 */
export function updatedLine(branding: CliBranding, to: string): string {
  return `Updated ${branding.displayName} to ${to}. The new version will be used on your next run.\n`;
}

/** A failure the user can do something about, so it names the thing to do. */
export function installFailedLine(
  branding: CliBranding,
  version: string,
  manualUpdateUrl: string | undefined,
): string {
  const suffix = manualUpdateUrl === undefined ? "" : ` Update manually: ${manualUpdateUrl}`;
  return `${branding.displayName} could not install the ${version} update.${suffix}\n`;
}

/**
 * The one failure that is not an inconvenience.
 *
 * Bytes that do not match a published digest are either a corrupted transfer or a substituted
 * artifact, and the user cannot tell which from here. It is stated explicitly rather than folded
 * into the generic warning, and it never suggests retrying by hand.
 */
export function digestRefusedLine(branding: CliBranding, version: string): string {
  return (
    `${branding.displayName} refused the ${version} update: the download did not match the ` +
    `release's published SHA-256 digest. Nothing was installed.\n`
  );
}
