import type { Adapter, AppModel, Check, Finding } from "@tryaura/aura-sdk";
import type { SkippedApp } from "@tryaura/core";
import type { ReportApp, ReportFinding } from "./report-types.js";

export type { ReportApp, ReportFinding } from "./report-types.js";

export function reportFinding(finding: Finding, checks: readonly Check[]): ReportFinding {
  const check = checks.find((candidate) => candidate.id === finding.checkId);
  if (check === undefined) {
    throw new Error(`Finding ${finding.id} names unregistered check ${finding.checkId}.`);
  }
  return Object.freeze({
    checkId: finding.checkId,
    ...(finding.details === undefined ? {} : { details: finding.details }),
    findingId: finding.id,
    fixability: finding.fixability ?? check.fixability,
    ...(finding.locations === undefined ? {} : { locations: finding.locations }),
    message: finding.message,
    ...(finding.metadata === undefined ? {} : { metadata: finding.metadata }),
    ...(finding.presentation === undefined ? {} : { presentation: finding.presentation }),
    scope: finding.scope,
    severity: finding.severity,
  });
}

/**
 * Every real adapter as the report carries it, in registry order.
 *
 * `skipped` is the scan's own record of adapters whose `detect` ran and reported the application
 * absent. An adapter missing from both `apps` and `skipped` crashed before it could establish
 * anything, and is reported without a detection scope: the scan already emits a diagnostic naming
 * the failure, and a line claiming Aura looked somewhere and came up empty would contradict it.
 */
export function reportApps(
  adapters: readonly Adapter[],
  apps: readonly AppModel[],
  skipped: readonly SkippedApp[],
): ReportApp[] {
  const installed = new Map(apps.map((app) => [app.adapterId, app]));
  const probed = new Set(skipped.map((app) => app.adapterId));
  const reported: ReportApp[] = [];
  for (const adapter of adapters) {
    if (adapter.synthetic === true) {
      continue;
    }
    const app = installed.get(adapter.id);
    if (app !== undefined) {
      reported.push(
        Object.freeze({
          appId: adapter.id,
          detection: Object.freeze({
            ...(app.detection.authenticated === undefined
              ? {}
              : { authenticated: app.detection.authenticated }),
            installed: true,
            ...(app.detection.version === undefined ? {} : { version: app.detection.version }),
          }),
          displayName: adapter.displayName,
          support: app.support,
        }),
      );
      continue;
    }
    const detectionScope = probed.has(adapter.id) ? adapter.detectionScope : undefined;
    reported.push(
      Object.freeze({
        appId: adapter.id,
        detection: Object.freeze({ installed: false }),
        ...(detectionScope === undefined ? {} : { detectionScope }),
        displayName: adapter.displayName,
      }),
    );
  }
  return reported;
}
