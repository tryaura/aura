import type {
  CheckRunEvent,
  CommandFailedEvent,
  Environment,
  FixRunEvent,
  SetupRunEvent,
  SetupRunOutcome,
  TelemetryCheckFlags,
  TelemetryCheckState,
  TelemetryCommand,
  TelemetrySetupActions,
  UndoRunEvent,
  UndoRunOutcome,
} from "@tryaura/aura-sdk";

import type { CheckReportV1, ReportFix } from "./report-types.js";
import type { GatheredSetup, SetupSelections } from "./setup/types.js";

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
    checks: checkStates(report),
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
    flags,
    kind: "check-run",
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
  readonly actions?: TelemetrySetupActions | undefined;
  readonly appliedOperationCount?: number | undefined;
  readonly durationMs: number;
  readonly exitCode: number;
  readonly outcome: SetupRunOutcome;
}

/** Draft of the one {@link SetupRunEvent} a setup run emits. */
export function setupRunEvent(facts: SetupRunFacts): Omit<SetupRunEvent, "at" | "distroVersion"> {
  return {
    ...(facts.actions === undefined ? {} : { actions: facts.actions }),
    ...(facts.appliedOperationCount === undefined
      ? {}
      : { appliedOperationCount: facts.appliedOperationCount }),
    command: "setup",
    durationMs: facts.durationMs,
    exitCode: facts.exitCode,
    kind: "setup-run",
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
 * Setup selections reduced to privacy-safe popularity metrics.
 *
 * Catalog MCP servers and bundled skills keep distribution-owned ids. Custom servers and
 * externally sourced skills are counted, never named — their metadata is user- or service-authored
 * text. Instruction sources, duplicate choices, private-source approvals, names, and transports
 * are dropped entirely.
 *
 * Only categories the run actually offered are reported, so an empty list always means the user
 * was asked and chose nothing — never that the distribution had nothing to ask about.
 */
export function setupActions({ offered, selections }: GatheredSetup): TelemetrySetupActions {
  const selectedSkills = selections.skills?.selected ?? [];
  const bundledSkills = selectedSkills.filter(isBundledSkillSelection);
  const selectedMcpServers = selections.mcp?.servers ?? [];
  const catalogIds = selectedMcpServers.flatMap((server) =>
    server.catalogId === undefined ? [] : [server.catalogId],
  );
  return {
    ...(offered.has("applications") ? { applications: selections.apps?.managed ?? [] } : {}),
    ...(offered.has("instructions")
      ? { instructions: instructionActions(selections.instructions) }
      : {}),
    ...(offered.has("mcpServers")
      ? {
          mcpServers: {
            catalogIds,
            customCount: selectedMcpServers.length - catalogIds.length,
          },
        }
      : {}),
    ...(offered.has("skills")
      ? {
          skills: {
            bundled: bundledSkills.map((skill) => ({ id: skill.id, source: skill.source })),
            externalCount: selectedSkills.length - bundledSkills.length,
          },
        }
      : {}),
    ...(offered.has("snippets") ? { snippets: selections.snippets?.selected ?? [] } : {}),
  };
}

type SelectedSkill = NonNullable<SetupSelections["skills"]>["selected"][number];
type BundledSkillSelection = SelectedSkill & {
  readonly source: `plugin:${string}`;
};

/** Narrows selected skills to metadata owned by a plugin bundled into the distribution. */
function isBundledSkillSelection(skill: SelectedSkill): skill is BundledSkillSelection {
  return skill.source.startsWith("plugin:");
}

/** Final instruction handling only; paths, sources, and duplicate choices stop here. */
function instructionActions(
  selections: SetupSelections["instructions"],
): NonNullable<TelemetrySetupActions["instructions"]> {
  if (selections === undefined) {
    return [];
  }
  return [{ action: selections.global.action }];
}

interface SeverityCounts {
  errors: number;
  informational: number;
  warnings: number;
}

/**
 * Per-check state and severity counts for every executed check, ordered by check ID.
 *
 * Read entirely off the report rather than off the check list beside it. The report is already
 * built from that list and partitions it three ways — a check that threw is dropped from
 * `passedChecks` and produces no findings — so taking the executed set from anywhere else would
 * let `counts.passed` and these states disagree inside one event.
 */
function checkStates(report: CheckReportV1): readonly TelemetryCheckState[] {
  const withFindings = countsByCheck(report.findings);
  const failed = new Set(
    report.diagnostics
      .filter((diagnostic) => diagnostic.phase === "check")
      .map((diagnostic) => diagnostic.id),
  );
  const states: TelemetryCheckState[] = [
    ...report.passedChecks.map(({ id }) => state(id, ZERO_COUNTS, "passed")),
    ...[...withFindings].map(([checkId, counts]) => state(checkId, counts, "findings")),
    ...[...failed].map((checkId) => state(checkId, ZERO_COUNTS, "failed")),
  ];
  return states.sort((left, right) => left.checkId.localeCompare(right.checkId));
}

const ZERO_COUNTS: SeverityCounts = Object.freeze({ errors: 0, informational: 0, warnings: 0 });

function state(
  checkId: string,
  counts: SeverityCounts,
  state: TelemetryCheckState["state"],
): TelemetryCheckState {
  return { checkId, ...counts, state };
}

/** Findings tallied by severity, keyed by the check that reported them. */
function countsByCheck(findings: CheckReportV1["findings"]): ReadonlyMap<string, SeverityCounts> {
  const byCheck = new Map<string, SeverityCounts>();
  for (const finding of findings) {
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
  return byCheck;
}
