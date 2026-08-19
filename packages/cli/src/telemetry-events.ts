import type {
  AuraManifest,
  CheckRunEvent,
  CommandFailedEvent,
  Environment,
  FixRunEvent,
  SetupRunEvent,
  SetupRunOutcome,
  TelemetryCheckFindings,
  TelemetryCheckFlags,
  TelemetryCommand,
  TelemetryManifestSummary,
  UndoRunEvent,
  UndoRunOutcome,
} from "@tryaura/aura-sdk";

import type { CheckReportV1, ReportFix } from "./report-types.js";

/**
 * Pure builders that turn the shapes commands already hold into telemetry event drafts.
 *
 * Everything here narrows: a whole report goes in, and only ids, counts, versions, booleans, and
 * durations come out. Paths, messages, display names, and diffs are dropped at this boundary so
 * no later layer has to remember to redact them.
 */

/** Milliseconds elapsed since `startedAt`, on the injected clock. */
export function elapsedMs(environment: Environment, startedAt: Date): number {
  return environment.now().getTime() - startedAt.getTime();
}

/** Draft of the one {@link CheckRunEvent} a check run emits. */
export function checkRunEvent(
  report: CheckReportV1,
  flags: TelemetryCheckFlags,
  durationMs: number,
): Omit<CheckRunEvent, "at" | "distroVersion"> {
  return {
    apps: report.apps.map((app) => ({
      appId: app.appId,
      installed: app.detection.installed,
    })),
    command: "check",
    counts: {
      errors: report.summary.errors,
      informational: report.summary.informational,
      passed: report.summary.passed,
      warnings: report.summary.warnings,
    },
    diagnosticCount: report.diagnostics.length,
    durationMs,
    exitCode: report.summary.exitCode,
    findings: findingsByCheck(report),
    flags,
    kind: "check-run",
    passedCheckIds: report.passedChecks.map((check) => check.id),
  };
}

/** Selects the check flags a telemetry event may carry from a wider command object. */
export function checkRunFlags(source: TelemetryCheckFlags): TelemetryCheckFlags {
  const { dryRun, fix, interactive, json, online, verbose } = source;
  return { dryRun, fix, interactive, json, online, verbose };
}

/** Draft of the {@link FixRunEvent} emitted when a check run carried `--fix`. */
export function fixRunEvent(
  fixes: readonly ReportFix[],
  dryRun: boolean,
  interactive: boolean,
  exitCode: number,
): Omit<FixRunEvent, "at" | "distroVersion"> {
  return {
    command: "check",
    dryRun,
    exitCode,
    fixes: fixes.map((fix) => ({ checkId: fix.checkId, status: fix.status })),
    interactive,
    kind: "fix-run",
  };
}

/** What a setup run reports about how it ended. */
export interface SetupRunFacts {
  readonly appliedOperationCount?: number | undefined;
  readonly durationMs: number;
  readonly exitCode: number;
  readonly manifest?: AuraManifest | undefined;
  readonly outcome: SetupRunOutcome;
}

/** Draft of the one {@link SetupRunEvent} a setup run emits. */
export function setupRunEvent(facts: SetupRunFacts): Omit<SetupRunEvent, "at" | "distroVersion"> {
  return {
    ...(facts.appliedOperationCount === undefined
      ? {}
      : { appliedOperationCount: facts.appliedOperationCount }),
    command: "setup",
    durationMs: facts.durationMs,
    exitCode: facts.exitCode,
    kind: "setup-run",
    ...(facts.manifest === undefined ? {} : { manifest: manifestSummary(facts.manifest) }),
    outcome: facts.outcome,
  };
}

/** What an undo run reports about how it ended. */
export interface UndoRunFacts {
  readonly exitCode: number;
  readonly outcome: UndoRunOutcome;
  readonly restoredOperationCount?: number | undefined;
  readonly skippedBackupCount?: number | undefined;
}

/** Draft of the one {@link UndoRunEvent} an undo run emits. */
export function undoRunEvent(facts: UndoRunFacts): Omit<UndoRunEvent, "at" | "distroVersion"> {
  return {
    command: "undo",
    exitCode: facts.exitCode,
    kind: "undo-run",
    outcome: facts.outcome,
    ...(facts.restoredOperationCount === undefined
      ? {}
      : { restoredOperationCount: facts.restoredOperationCount }),
    ...(facts.skippedBackupCount === undefined
      ? {}
      : { skippedBackupCount: facts.skippedBackupCount }),
  };
}

/** Draft of the {@link CommandFailedEvent} an unexpected operational failure emits. */
export function commandFailedEvent(
  command: TelemetryCommand,
  exitCode: number,
): Omit<CommandFailedEvent, "at" | "distroVersion"> {
  return { command, exitCode, kind: "command-failed" };
}

/**
 * The manifest reduced to what popularity metrics need.
 *
 * Catalog MCP servers and bundled skills keep distribution-owned ids. Custom servers and
 * externally sourced skills are counted, never named — their metadata is user- or service-authored
 * text. Ownership is dropped entirely because it references files.
 */
export function manifestSummary(manifest: AuraManifest): TelemetryManifestSummary {
  const catalogIds = manifest.mcpServers.flatMap((server) =>
    server.catalogId === undefined ? [] : [server.catalogId],
  );
  const bundledSkills = manifest.skills.filter(isBundledSkill);
  return {
    managedAppIds: Object.entries(manifest.apps)
      .filter(([, app]) => app.managed)
      .map(([appId]) => appId),
    mcpServers: {
      catalogIds,
      customCount: manifest.mcpServers.length - catalogIds.length,
    },
    skills: {
      bundled: bundledSkills.map((skill) => ({
        id: skill.id,
        source: skill.source,
        version: skill.version,
      })),
      externalCount: manifest.skills.length - bundledSkills.length,
    },
    snippets: manifest.snippets.map((snippet) => ({ id: snippet.id, version: snippet.version })),
  };
}

type BundledManifestSkill = AuraManifest["skills"][number] & {
  readonly source: `plugin:${string}`;
};

/** Narrows manifest skills to metadata owned by a plugin bundled into the distribution. */
function isBundledSkill(skill: AuraManifest["skills"][number]): skill is BundledManifestSkill {
  return skill.source.startsWith("plugin:");
}

/** Per-check severity counts for every check that produced findings. */
function findingsByCheck(report: CheckReportV1): readonly TelemetryCheckFindings[] {
  const byCheck = new Map<string, { errors: number; informational: number; warnings: number }>();
  for (const finding of report.findings) {
    const counts = byCheck.get(finding.checkId) ?? { errors: 0, informational: 0, warnings: 0 };
    if (finding.severity === "error") {
      counts.errors += 1;
    } else if (finding.severity === "warn") {
      counts.warnings += 1;
    } else {
      counts.informational += 1;
    }
    byCheck.set(finding.checkId, counts);
  }
  return [...byCheck.entries()].map(([checkId, counts]) => ({ checkId, ...counts }));
}
