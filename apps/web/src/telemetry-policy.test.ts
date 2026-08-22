import type {
  CheckRunEvent,
  FixRunEvent,
  SetupRunEvent,
  TelemetryBatchV1,
  TelemetrySetupActions,
} from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { isOfficialTelemetryBatch } from "./telemetry-policy.js";

const AT = "2026-08-22T12:34:56.000Z";
const VERSION = "1.2.3";
const CHECK_EVENT: CheckRunEvent = {
  apps: [{ appId: "codex", installed: true }],
  at: AT,
  checks: [
    {
      checkId: "ENV-001",
      errors: 0,
      informational: 0,
      state: "passed",
      warnings: 0,
    },
  ],
  command: "check",
  counts: { errors: 0, informational: 0, passed: 1, warnings: 0 },
  diagnosticCount: 0,
  distroVersion: VERSION,
  durationMs: 1,
  exitCode: 0,
  flags: {
    dryRun: false,
    fix: false,
    interactive: false,
    json: false,
    online: false,
    verbose: false,
  },
  kind: "check-run",
};
const FIX_EVENT: FixRunEvent = {
  at: AT,
  command: "check",
  distroVersion: VERSION,
  dryRun: false,
  exitCode: 0,
  fixes: [{ checkId: "ENV-001", status: "applied" }],
  interactive: true,
  kind: "fix-run",
};

function batch(events: TelemetryBatchV1["events"]): TelemetryBatchV1 {
  return { events, kind: "aura-telemetry", schemaVersion: 1 };
}

function setup(actions: TelemetrySetupActions): SetupRunEvent {
  return {
    actions,
    at: AT,
    command: "setup",
    distroVersion: VERSION,
    durationMs: 1,
    exitCode: 0,
    kind: "setup-run",
    outcome: "applied",
  };
}

describe("official telemetry policy", () => {
  it("accepts the identifiers emitted by the official distribution", () => {
    expect(
      isOfficialTelemetryBatch(
        batch([
          CHECK_EVENT,
          FIX_EVENT,
          setup({
            applications: ["claude-code", "codex", "cursor"],
            instructions: [{ action: "consolidate" }],
            mcpServers: { catalogIds: ["official/github"], customCount: 1 },
            skills: { bundled: [], externalCount: 1 },
            snippets: ["official/typescript-style"],
          }),
        ]),
      ),
    ).toBe(true);
  });

  it.each([
    ["app id", batch([{ ...CHECK_EVENT, apps: [{ appId: "private", installed: true }] }])],
    [
      "check id",
      batch([
        {
          ...CHECK_EVENT,
          checks: [{ ...CHECK_EVENT.checks[0], checkId: "private" }],
        },
      ]),
    ],
    ["fix check id", batch([{ ...FIX_EVENT, fixes: [{ checkId: "private", status: "applied" }] }])],
    ["application selection", batch([setup({ applications: ["private"] })])],
    [
      "MCP catalog id",
      batch([setup({ mcpServers: { catalogIds: ["private/server"], customCount: 0 } })]),
    ],
    ["snippet id", batch([setup({ snippets: ["private/snippet"] })])],
    [
      "bundled skill",
      batch([
        setup({
          skills: {
            bundled: [{ id: "private", source: "plugin:private" }],
            externalCount: 0,
          },
        }),
      ]),
    ],
    [
      "repeated instruction actions",
      batch([setup({ instructions: [{ action: "keep" }, { action: "template" }] })]),
    ],
  ])("rejects a non-official %s", (_label, value) => {
    expect(isOfficialTelemetryBatch(value)).toBe(false);
  });

  it("requires a non-empty batch of stamped release events", () => {
    expect(isOfficialTelemetryBatch(batch([]))).toBe(false);
    expect(
      isOfficialTelemetryBatch(batch([{ ...CHECK_EVENT, distroVersion: "local build" }])),
    ).toBe(false);
    expect(isOfficialTelemetryBatch(batch([{ ...CHECK_EVENT, distroVersion: "0.0.0" }]))).toBe(
      false,
    );
  });
});
