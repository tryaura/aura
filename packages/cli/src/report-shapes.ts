import type { Adapter, AppModel, Check, Finding } from "@tryaura/aura-sdk";

import type { ReportApp, ReportFinding } from "./report.js";

export function reportFinding(finding: Finding, checks: readonly Check[]): ReportFinding {
  const check = checks.find((candidate) => candidate.id === finding.checkId);
  if (check === undefined) {
    throw new Error(`Finding ${finding.id} names unregistered check ${finding.checkId}.`);
  }
  return Object.freeze({
    checkId: finding.checkId,
    ...(finding.details === undefined ? {} : { details: finding.details }),
    findingId: finding.id,
    fixability: check.fixability,
    ...(finding.locations === undefined ? {} : { locations: finding.locations }),
    message: finding.message,
    ...(finding.metadata === undefined ? {} : { metadata: finding.metadata }),
    ...(finding.presentation === undefined ? {} : { presentation: finding.presentation }),
    scope: finding.scope,
    severity: finding.severity,
  });
}

export function reportApps(adapters: readonly Adapter[], apps: readonly AppModel[]): ReportApp[] {
  const installed = new Map(apps.map((app) => [app.adapterId, app]));
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
    reported.push(
      Object.freeze({
        appId: adapter.id,
        detection: Object.freeze({ installed: false }),
        displayName: adapter.displayName,
      }),
    );
  }
  return reported;
}
