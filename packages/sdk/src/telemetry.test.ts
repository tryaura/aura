import { describe, expect, it } from "vitest";

import {
  type CheckRunEvent,
  type CommandFailedEvent,
  decodeTelemetryBatchV1,
  type DistroCommandEvent,
  type FixRunEvent,
  type SetupRunEvent,
  type TelemetryEvent,
} from "./index.js";

const AT = "2026-08-22T12:34:56.000Z";

const CHECK_EVENT: CheckRunEvent = {
  apps: [{ appId: "codex", installed: true }],
  at: AT,
  checks: [
    {
      checkId: "ENV-001",
      errors: 0,
      informational: 1,
      state: "findings",
      warnings: 0,
    },
  ],
  command: "check",
  counts: { errors: 0, informational: 1, passed: 2, warnings: 0 },
  diagnosticCount: 0,
  distroVersion: "1.2.3",
  durationMs: 12.5,
  exitCode: 0,
  flags: {
    dryRun: false,
    fix: false,
    interactive: true,
    json: false,
    online: false,
    verbose: false,
  },
  kind: "check-run",
};

const FIX_EVENT: FixRunEvent = {
  at: AT,
  command: "check",
  distroVersion: "1.2.3",
  dryRun: false,
  exitCode: 0,
  fixes: [{ checkId: "ENV-001", status: "applied" }],
  interactive: true,
  kind: "fix-run",
};

const SETUP_EVENT: SetupRunEvent = {
  actions: {
    applications: ["codex"],
    instructions: [{ action: "consolidate" }],
    mcpServers: { catalogIds: ["official/github"], customCount: 1 },
    skills: {
      bundled: [{ id: "review", source: "plugin:official" }],
      externalCount: 2,
    },
    snippets: [],
  },
  appliedOperationCount: 3,
  at: AT,
  command: "setup",
  distroVersion: "1.2.3",
  durationMs: 25,
  exitCode: 0,
  kind: "setup-run",
  outcome: "applied",
};

const UNDO_EVENT: TelemetryEvent = {
  at: AT,
  command: "undo",
  distroVersion: "1.2.3",
  exitCode: 0,
  kind: "undo-run",
  outcome: "restored",
  restoredOperationCount: 2,
  skippedBackupCount: 1,
};

const FAILED_EVENT: CommandFailedEvent = {
  at: AT,
  command: "setup",
  distroVersion: "1.2.3",
  exitCode: 3,
  kind: "command-failed",
};

const DISTRO_COMMAND_EVENT: DistroCommandEvent = {
  at: AT,
  command: "sync",
  counts: { profiles: 4 },
  distroVersion: "1.2.3",
  durationMs: 12,
  event: "sync-run",
  exitCode: 0,
  flags: { force: true },
  kind: "distro-command",
  outcome: "applied",
};

const EVENTS: readonly TelemetryEvent[] = [
  CHECK_EVENT,
  DISTRO_COMMAND_EVENT,
  FIX_EVENT,
  SETUP_EVENT,
  UNDO_EVENT,
  FAILED_EVENT,
];

interface TestBatch {
  readonly events: readonly unknown[];
  readonly kind: string;
  readonly schemaVersion: number;
}

function batch(events: readonly unknown[] = EVENTS): TestBatch {
  return { events, kind: "aura-telemetry", schemaVersion: 1 };
}

describe("decodeTelemetryBatchV1", () => {
  it("accepts every event variant and preserves absent optional fields", () => {
    const setupWithoutActions: TelemetryEvent = {
      at: AT,
      command: "setup",
      durationMs: 1,
      exitCode: 0,
      kind: "setup-run",
      outcome: "aborted",
    };
    const bareDistroCommand: TelemetryEvent = {
      at: AT,
      command: "sync",
      event: "sync-run",
      kind: "distro-command",
    };
    const input = batch([...EVENTS, setupWithoutActions, bareDistroCommand]);

    expect(decodeTelemetryBatchV1(input)).toEqual(input);
  });

  it.each([
    ["wrong envelope kind", { ...batch(), kind: "other" }],
    ["wrong schema", { ...batch(), schemaVersion: 2 }],
    ["unsafe count", batch([{ ...CHECK_EVENT, diagnosticCount: Number.MAX_SAFE_INTEGER + 1 }])],
    ["non-canonical timestamp", batch([{ ...FAILED_EVENT, at: "2026-08-22" }])],
    ["wrong command", batch([{ ...FIX_EVENT, command: "setup" }])],
    ["unknown event field", batch([{ ...FAILED_EVENT, unexpected: "private value" }])],
    ["shouted command word", batch([{ ...DISTRO_COMMAND_EVENT, command: "Sync" }])],
    ["free-text event name", batch([{ ...DISTRO_COMMAND_EVENT, event: "/home/ana not found" }])],
    ["free-text outcome", batch([{ ...DISTRO_COMMAND_EVENT, outcome: "ENOENT: no such file" }])],
    ["non-numeric count", batch([{ ...DISTRO_COMMAND_EVENT, counts: { profiles: "four" } }])],
    ["non-boolean flag", batch([{ ...DISTRO_COMMAND_EVENT, flags: { force: "yes" } }])],
    ["free-text count key", batch([{ ...DISTRO_COMMAND_EVENT, counts: { "/home/ana": 1 } }])],
    [
      "unbounded labelled record",
      batch([
        {
          ...DISTRO_COMMAND_EVENT,
          counts: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`c${index}`, 1])),
        },
      ]),
    ],
    [
      "unknown nested field",
      batch([
        {
          ...CHECK_EVENT,
          apps: [{ appId: "codex", installed: true, version: "private" }],
        },
      ]),
    ],
    [
      "invalid plugin source",
      batch([
        {
          ...SETUP_EVENT,
          actions: {
            skills: {
              bundled: [{ id: "review", source: "repository" }],
              externalCount: 0,
            },
          },
        },
      ]),
    ],
  ])("rejects %s", (_label, input) => {
    expect(decodeTelemetryBatchV1(input)).toBeUndefined();
  });

  it("rejects explicit undefined for an optional field because it is not JSON", () => {
    expect(
      decodeTelemetryBatchV1(batch([{ ...FAILED_EVENT, distroVersion: undefined }])),
    ).toBeUndefined();
  });
});
