import type { Writable } from "node:stream";

import { updateEnvironmentVariable } from "./diagnostics.js";
import type { StartupUpdateOutcome } from "./outcome.js";
import type { CliBranding, CliExitCode } from "../types.js";

interface ExplicitUpdateReport {
  readonly branding: CliBranding;
  readonly manualUpdateUrl: string | undefined;
  readonly outcome: StartupUpdateOutcome;
  readonly stderr: Writable;
  readonly stdout: Writable;
}

export function reportExplicitUpdate(request: ExplicitUpdateReport): CliExitCode {
  const { branding, outcome } = request;
  if (outcome.kind === "current") {
    request.stdout.write(`${branding.displayName} is already up to date.\n`);
    return 0;
  }
  if (outcome.kind === "installed") {
    return 0;
  }
  if (outcome.kind === "busy") {
    request.stderr.write(
      `${branding.displayName} did not update because another update is in progress. Try again shortly.\n`,
    );
    return 1;
  }
  if (outcome.kind === "skipped") {
    request.stderr.write(explicitSkipLine(branding, outcome.reason));
    return outcome.reason === "cached" ? 3 : 2;
  }
  if (outcome.reason !== "install" && outcome.reason !== "untrusted-download") {
    request.stderr.write(
      explicitFailureLine(branding, outcome.reason, request.manualUpdateUrl ?? branding.docsUrl),
    );
  }
  return 3;
}

function explicitSkipLine(
  branding: CliBranding,
  reason: Extract<StartupUpdateOutcome, { readonly kind: "skipped" }>["reason"],
): string {
  if (reason === "continuous-integration") {
    return `${branding.displayName} cannot update while CI is set.\n`;
  }
  if (reason === "disabled") {
    return (
      `${branding.displayName} updates are disabled by ` +
      `${updateEnvironmentVariable(branding.command)}.\n`
    );
  }
  if (reason === "informational-run") {
    return `${branding.displayName} did not update because this invocation only requests information.\n`;
  }
  if (reason === "not-a-regular-file") {
    return `${branding.displayName} cannot update because its executable is not a regular file.\n`;
  }
  if (reason === "not-a-terminal") {
    return `${branding.displayName} update requires an interactive stdin, stdout, and stderr.\n`;
  }
  if (reason === "unstamped-version") {
    return `${branding.displayName} cannot update an unstamped development build.\n`;
  }
  if (reason === "unsupported-target") {
    return `${branding.displayName} cannot update on this platform and architecture.\n`;
  }
  return `${branding.displayName} could not bypass the update cache. Try again.\n`;
}

function explicitFailureLine(
  branding: CliBranding,
  reason: Exclude<
    Extract<StartupUpdateOutcome, { readonly kind: "failed" }>["reason"],
    "install" | "untrusted-download"
  >,
  manualUpdateUrl: string | undefined,
): string {
  if (reason === "network") {
    return `${branding.displayName} could not check for updates. Check your network connection and try again.\n`;
  }
  if (reason === "untrusted-release") {
    return `${branding.displayName} refused untrusted release metadata. Nothing was installed.\n`;
  }
  const suffix = manualUpdateUrl === undefined ? "" : ` Update manually: ${manualUpdateUrl}`;
  if (reason === "invalid-release") {
    return `${branding.displayName} received invalid release metadata.${suffix}\n`;
  }
  if (reason === "stale-manifest") {
    return `${branding.displayName} received stale release metadata.${suffix}\n`;
  }
  return `${branding.displayName} could not check for updates because of an unexpected error.${suffix}\n`;
}
