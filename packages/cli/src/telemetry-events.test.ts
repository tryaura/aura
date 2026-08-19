import type { AuraManifest } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import type { CheckReportV1 } from "./report-types.js";
import {
  checkRunEvent,
  commandFailedEvent,
  fixRunEvent,
  manifestSummary,
  setupRunEvent,
  undoRunEvent,
} from "./telemetry-events.js";

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
    diagnostics: 1,
    errors: 1,
    exitCode: 2,
    informational: 1,
    passed: 1,
    warnings: 1,
  },
};

const MANIFEST: AuraManifest = {
  apps: { "claude-code": { managed: true }, codex: { managed: false } },
  mcpServers: [
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
  ownership: { "claude-code": { files: ["/home/user/.claude/CLAUDE.md"], mcpServerNames: [] } },
  schemaVersion: 1,
  skills: [
    { id: "review", pinned: false, source: "plugin:official", treeHash: "abc", version: "1.0.0" },
    {
      id: "private-roadmap",
      pinned: false,
      source: "directory:internal-project",
      treeHash: "private-hash",
      version: "confidential-version-label",
    },
  ],
  snippets: [{ hash: "def", id: "official/style", pinned: false, version: "2.0.0" }],
};

describe("checkRunEvent", () => {
  it("aggregates findings per check and drops externally detected version strings", () => {
    const event = checkRunEvent(REPORT, FLAGS, 1200);

    expect(event).toEqual({
      apps: [
        { appId: "claude-code", installed: true },
        { appId: "codex", installed: false },
      ],
      command: "check",
      counts: { errors: 1, informational: 1, passed: 1, warnings: 1 },
      diagnosticCount: 1,
      durationMs: 1200,
      exitCode: 2,
      findings: [
        { checkId: "INS-001", errors: 1, informational: 0, warnings: 1 },
        { checkId: "MCP-002", errors: 0, informational: 1, warnings: 0 },
      ],
      flags: FLAGS,
      kind: "check-run",
      passedCheckIds: ["ENV-001"],
    });
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

describe("manifestSummary", () => {
  it("lists distribution-owned metadata and counts externally sourced skills", () => {
    expect(manifestSummary(MANIFEST)).toEqual({
      managedAppIds: ["claude-code"],
      mcpServers: { catalogIds: ["official/context7"], customCount: 1 },
      skills: {
        bundled: [{ id: "review", source: "plugin:official", version: "1.0.0" }],
        externalCount: 1,
      },
      snippets: [{ id: "official/style", version: "2.0.0" }],
    });
  });
});

describe("privacy by construction", () => {
  it("never lets paths, messages, names, or hashes survive into an event", () => {
    const events = [
      checkRunEvent(REPORT, FLAGS, 5),
      setupRunEvent({ durationMs: 5, exitCode: 0, manifest: MANIFEST, outcome: "applied" }),
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
