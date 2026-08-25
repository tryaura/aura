import type {
  CheckRunEvent,
  TelemetryBatchV1,
  TelemetryEvent,
  TelemetrySetupActions,
} from "@tryaura/aura-sdk";

export const OFFICIAL_TELEMETRY_IDS = Object.freeze({
  applications: Object.freeze(["claude-code", "codex", "cursor", "legacy-instructions"]),
  bundledSkills: Object.freeze<string[]>([]),
  checks: Object.freeze([
    "ENV-001",
    "ENV-002",
    "ENV-003",
    "ENV-004",
    "INS-001",
    "INS-002",
    "INS-003",
    "INS-004",
    "INS-005",
    "INS-006",
    "INS-007",
    "INS-008",
    "MCP-001",
    "MCP-002",
    "MCP-003",
    "MCP-005",
    "MGD-002",
    "MGD-003",
    "SKL-001",
    "SKL-002",
    "SKL-003",
    "SKL-004",
  ]),
  mcpCatalog: Object.freeze(["official/atlassian-rovo", "official/github", "official/sentry"]),
  snippets: Object.freeze([
    "official/ask-before-destructive",
    "official/commit-conventions",
    "official/confluence-references",
    "official/jira-linking",
    "official/pr-descriptions",
    "official/python-style",
    "official/typescript-style",
  ]),
});
const OFFICIAL_APP_IDS: ReadonlySet<string> = new Set(OFFICIAL_TELEMETRY_IDS.applications);
const OFFICIAL_CHECK_IDS: ReadonlySet<string> = new Set(OFFICIAL_TELEMETRY_IDS.checks);
const OFFICIAL_MCP_CATALOG_IDS: ReadonlySet<string> = new Set(OFFICIAL_TELEMETRY_IDS.mcpCatalog);
const OFFICIAL_SNIPPET_IDS: ReadonlySet<string> = new Set(OFFICIAL_TELEMETRY_IDS.snippets);
const OFFICIAL_BUNDLED_SKILLS: ReadonlySet<string> = new Set(OFFICIAL_TELEMETRY_IDS.bundledSkills);
const RELEASE_VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/u;

/** Restricts the generic SDK wire schema to values the official Aura distribution can emit. */
export function isOfficialTelemetryBatch(batch: TelemetryBatchV1): boolean {
  if (batch.events.length === 0) {
    return false;
  }
  return batch.events.every(isOfficialTelemetryEvent);
}

function isOfficialTelemetryEvent(event: TelemetryEvent): boolean {
  if (!isReleaseVersion(event.distroVersion)) {
    return false;
  }
  switch (event.kind) {
    case "check-run":
      return isOfficialCheckRun(event);
    case "fix-run":
      return hasOnlyOfficialIds(
        event.fixes.map((fix) => fix.checkId),
        OFFICIAL_CHECK_IDS,
      );
    case "setup-run":
      return event.actions === undefined || isOfficialSetupActions(event.actions);
    case "command-failed":
    case "undo-run":
      return true;
    // The official distribution registers no commands of its own, so an event attributed to one
    // did not come from a build this service can vouch for.
    case "distro-command":
      return false;
  }
}

function isOfficialCheckRun(event: CheckRunEvent): boolean {
  return (
    hasOnlyOfficialIds(
      event.apps.map((app) => app.appId),
      OFFICIAL_APP_IDS,
    ) &&
    hasOnlyOfficialIds(
      event.checks.map((check) => check.checkId),
      OFFICIAL_CHECK_IDS,
    )
  );
}

function isOfficialSetupActions(actions: TelemetrySetupActions): boolean {
  return (
    hasOnlyOfficialOptionalIds(actions.applications, OFFICIAL_APP_IDS) &&
    hasAtMostOneInstructionAction(actions.instructions) &&
    isOfficialMcpActions(actions.mcpServers) &&
    hasOnlyOfficialOptionalIds(actions.snippets, OFFICIAL_SNIPPET_IDS) &&
    isOfficialSkillActions(actions.skills)
  );
}

function isReleaseVersion(value: string | undefined): boolean {
  return value !== undefined && value !== "0.0.0" && RELEASE_VERSION.test(value);
}

function hasAtMostOneInstructionAction(actions: TelemetrySetupActions["instructions"]): boolean {
  return actions === undefined || actions.length <= 1;
}

function isOfficialMcpActions(actions: TelemetrySetupActions["mcpServers"]): boolean {
  return actions === undefined || hasOnlyOfficialIds(actions.catalogIds, OFFICIAL_MCP_CATALOG_IDS);
}

function isOfficialSkillActions(actions: TelemetrySetupActions["skills"]): boolean {
  return (
    actions === undefined ||
    hasOnlyOfficialIds(
      actions.bundled.map((skill) => `${skill.source}\0${skill.id}`),
      OFFICIAL_BUNDLED_SKILLS,
    )
  );
}

function hasOnlyOfficialOptionalIds(
  values: readonly string[] | undefined,
  allowed: ReadonlySet<string>,
): boolean {
  return values === undefined || hasOnlyOfficialIds(values, allowed);
}

function hasOnlyOfficialIds(values: readonly string[], allowed: ReadonlySet<string>): boolean {
  if (values.length > allowed.size) {
    return false;
  }
  const unique = new Set(values);
  return unique.size === values.length && values.every((value) => allowed.has(value));
}
