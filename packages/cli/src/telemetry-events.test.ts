import { describe, expect, it } from "vitest";

import type { CheckReportV1 } from "./report-types.js";
import {
  checkRunEvent,
  commandFailedEvent,
  fixRunEvent,
  setupActions,
  setupRunEvent,
  undoRunEvent,
} from "./telemetry-events.js";
import type { SetupSelections, SetupTelemetryCategory } from "./setup/types.js";

const FLAGS = {
  dryRun: false,
  fix: false,
  interactive: false,
  json: false,
  online: false,
  verbose: false,
};

const REPORT: CheckReportV1 = {
  apps: [
    {
      appId: "claude-code",
      detection: { installed: true, version: "2.1.0" },
      displayName: "Claude Code",
    },
    { appId: "codex", detection: { installed: false }, displayName: "Codex" },
  ],
  diagnostics: [
    { id: "ENV-009", message: "adapter failed", path: "/home/user/secret.json", phase: "detect" },
    { id: "SEC-001", message: "check failed", phase: "check" },
  ],
  findings: [
    {
      checkId: "INS-001",
      findingId: "shared-source",
      fixability: "auto",
      message: "The shared instruction source is missing.",
      scope: "global",
      severity: "error",
    },
    {
      checkId: "INS-001",
      findingId: "second",
      fixability: "manual",
      message: "Another one.",
      scope: "global",
      severity: "warn",
    },
    {
      checkId: "MCP-002",
      findingId: "advice",
      fixability: "manual",
      message: "Informational only.",
      scope: "project",
      severity: "info",
    },
  ],
  kind: "check-report",
  passedChecks: [{ id: "ENV-001", title: "Agent applications use supported versions" }],
  schemaVersion: 1,
  status: "error",
  summary: {
    categories: {},
    diagnostics: 2,
    errors: 1,
    exitCode: 2,
    informational: 1,
    passed: 1,
    warnings: 1,
  },
};

const SELECTIONS: SetupSelections = {
  apps: { managed: ["claude-code"] },
  instructions: {
    global: {
      action: "consolidate",
      duplicateWinners: { "private-duplicate": "/home/user/.claude/CLAUDE.md:1:3" },
      scope: "global",
      selectedSources: ["/home/user/.claude/CLAUDE.md"],
      targetPath: "/home/user/agents/AGENTS.md",
    },
    project: {
      action: "skip",
      duplicateWinners: {},
      scope: "project",
      selectedSources: [],
      targetPath: "/home/user/project/AGENTS.md",
    },
  },
  mcp: {
    servers: [
      {
        apps: ["claude-code"],
        catalogId: "official/context7",
        name: "context7",
        scope: "global",
        transport: { type: "http", url: "https://mcp.context7.com/mcp" },
      },
      {
        apps: ["claude-code"],
        name: "my-private-server",
        scope: "project",
        transport: { type: "http", url: "https://internal.example.com/mcp" },
      },
    ],
  },
};

const PRIVATE_SELECTIONS: SetupSelections = {
  ...SELECTIONS,
  skills: {
    approvedPrivateSourceIds: ["directory:internal-project"],
    selected: [
      { id: "review", source: "plugin:official" },
      { id: "private-roadmap", source: "directory:internal-project" },
    ],
  },
  snippets: { selected: ["official/style"] },
};

const EVERY_CATEGORY: ReadonlySet<SetupTelemetryCategory> = new Set([
  "applications",
  "instructions",
  "mcpServers",
  "skills",
  "snippets",
]);

describe("checkRunEvent", () => {
  it("aggregates findings per check and drops externally detected version strings", () => {
    const event = checkRunEvent(REPORT, FLAGS, 1200);

    expect(event).toEqual({
      apps: [
        { appId: "claude-code", installed: true },
        { appId: "codex", installed: false },
      ],
      command: "check",
      checks: [
        { checkId: "ENV-001", errors: 0, informational: 0, state: "passed", warnings: 0 },
        { checkId: "INS-001", errors: 1, informational: 0, state: "findings", warnings: 1 },
        { checkId: "MCP-002", errors: 0, informational: 1, state: "findings", warnings: 0 },
        { checkId: "SEC-001", errors: 0, informational: 0, state: "failed", warnings: 0 },
      ],
      counts: { errors: 1, informational: 1, passed: 1, warnings: 1 },
      diagnosticCount: 2,
      durationMs: 1200,
      exitCode: 2,
      flags: FLAGS,
      kind: "check-run",
    });
  });

  it("keeps every executed check accounted for exactly once", () => {
    const { checks } = checkRunEvent(REPORT, FLAGS, 1200);

    expect(checks).toHaveLength(new Set(checks.map(({ checkId }) => checkId)).size);
    expect(checks.filter(({ state }) => state === "passed")).toHaveLength(REPORT.summary.passed);
  });
});

describe("fixRunEvent", () => {
  it("keeps the owning check and the outcome, dropping paths and diffs", () => {
    const event = fixRunEvent(
      [
        {
          checkId: "INS-001",
          findingId: "shared-source",
          manualSteps: [],
          operations: [{ effect: "create", paths: ["/home/user/agents/AGENTS.md"] }],
          status: "applied",
          summary: "Create the shared instruction source",
        },
      ],
      false,
      true,
      0,
    );

    expect(event).toEqual({
      command: "check",
      dryRun: false,
      exitCode: 0,
      fixes: [{ checkId: "INS-001", status: "applied" }],
      interactive: true,
      kind: "fix-run",
    });
  });
});

describe("setupActions", () => {
  it("lists final distribution-owned choices and counts external selections", () => {
    expect(setupActions({ offered: EVERY_CATEGORY, selections: PRIVATE_SELECTIONS })).toEqual({
      applications: ["claude-code"],
      instructions: [
        { action: "consolidate", scope: "global" },
        { action: "skip", scope: "project" },
      ],
      mcpServers: { catalogIds: ["official/context7"], customCount: 1 },
      skills: {
        bundled: [{ id: "review", source: "plugin:official" }],
        externalCount: 1,
      },
      snippets: ["official/style"],
    });
  });

  it("reports an empty choice only for a category the run actually offered", () => {
    expect(setupActions({ offered: new Set(["skills"]), selections: {} })).toEqual({
      skills: { bundled: [], externalCount: 0 },
    });
  });

  it("omits a category the run never offered, even when selections carry one", () => {
    expect(setupActions({ offered: new Set(), selections: PRIVATE_SELECTIONS })).toEqual({});
  });
});

describe("privacy by construction", () => {
  it("never lets paths, messages, names, or hashes survive into an event", () => {
    const events = [
      checkRunEvent(REPORT, FLAGS, 5),
      setupRunEvent({
        actions: setupActions({ offered: EVERY_CATEGORY, selections: PRIVATE_SELECTIONS }),
        durationMs: 5,
        exitCode: 0,
        outcome: "applied",
      }),
      undoRunEvent({ exitCode: 0, outcome: "restored", restoredOperationCount: 2 }),
      commandFailedEvent("undo", 3),
    ];

    const serialized = JSON.stringify(events);
    for (const banned of [
      "message",
      "path",
      "details",
      "displayName",
      "name",
      "transport",
      "url",
      "ownership",
      "hash",
      "/home/user",
      "directory:internal-project",
      "private-roadmap",
      "confidential-version-label",
    ]) {
      expect(serialized).not.toContain(banned);
    }
  });
});
