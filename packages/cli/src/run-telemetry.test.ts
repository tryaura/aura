import type { TelemetryEvent, TelemetrySink } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { runCli } from "./index.js";
import { parseCheckReport } from "./test-support/check-output-schema.js";
import { createCapture, distro, findingPlugin, throwingPlugin } from "./testing.js";

const CLOCK = (): Date => new Date("2026-08-18T12:00:00.000Z");

function capturingSink(): { readonly events: TelemetryEvent[]; readonly sink: TelemetrySink } {
  const events: TelemetryEvent[] = [];
  return {
    events,
    sink: {
      flush: () => Promise.resolve(),
      record: (event) => {
        events.push(event);
      },
    },
  };
}

describe("runCli telemetry", () => {
  it("emits one stamped check-run event per run", async () => {
    const { events, sink } = capturingSink();
    const capture = createCapture(["check"]);

    const exitCode = await runCli(
      { ...distro([findingPlugin("info", [])]), telemetry: sink },
      { ...capture.runtime, now: CLOCK },
    );

    expect(exitCode).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      at: "2026-08-18T12:00:00.000Z",
      command: "check",
      counts: { errors: 0, informational: 0, passed: 1, warnings: 0 },
      distroVersion: "1.2.3",
      durationMs: 0,
      exitCode: 0,
      findings: [],
      flags: { dryRun: false, fix: false, interactive: false, json: false, online: false },
      kind: "check-run",
      passedCheckIds: ["fixture-info/INFO"],
    });
  });

  it("adds a fix-run event with planned statuses on a --fix --dry-run", async () => {
    const { events, sink } = capturingSink();
    const capture = createCapture(["check", "--fix", "--dry-run"]);

    const exitCode = await runCli(
      { ...distro([findingPlugin("error", [])]), telemetry: sink },
      { ...capture.runtime, now: CLOCK },
    );

    expect(exitCode).toBe(0);
    const kinds = events.map((event) => event.kind);
    expect(kinds).toEqual(["check-run", "fix-run"]);
    expect(events[0]).toMatchObject({ exitCode: 0, kind: "check-run" });
    expect(events[1]).toMatchObject({
      command: "check",
      dryRun: true,
      exitCode: 0,
      kind: "fix-run",
    });
  });

  it("keeps --json output as one clean document while events flow", async () => {
    const { events, sink } = capturingSink();
    const capture = createCapture(["check", "--json"]);

    const exitCode = await runCli(
      { ...distro([findingPlugin("info", [])]), telemetry: sink },
      { ...capture.runtime, now: CLOCK },
    );

    expect(exitCode).toBe(0);
    expect(parseCheckReport(capture.stdout.text)).toMatchObject({ kind: "check-report" });
    expect(capture.stderr.text).toBe("");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ flags: { json: true }, kind: "check-run" });
  });

  it("reports an operationally failed run through the check-run event", async () => {
    // A throwing plugin is modeled by core as diagnostics, so the run still completes and the
    // event carries exit 3. `command-failed` is reserved for throws that escape the command.
    const { events, sink } = capturingSink();
    const capture = createCapture(["check"]);

    const exitCode = await runCli(
      { ...distro([throwingPlugin()]), telemetry: sink },
      { ...capture.runtime, now: CLOCK },
    );

    expect(exitCode).toBe(3);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ exitCode: 3, kind: "check-run" });
  });

  it("changes nothing about the run when the sink throws everywhere", async () => {
    const clean = createCapture(["check"]);
    const cleanExit = await runCli(distro([findingPlugin("info", [])]), clean.runtime);

    const hostile = createCapture(["check"]);
    const hostileSink: TelemetrySink = {
      flush: () => Promise.reject(new Error("sink flush bug")),
      record: () => {
        throw new Error("sink record bug");
      },
    };
    const hostileExit = await runCli(
      { ...distro([findingPlugin("info", [])]), telemetry: hostileSink },
      hostile.runtime,
    );

    expect(hostileExit).toBe(cleanExit);
    expect(hostile.stdout.text).toBe(clean.stdout.text);
    expect(hostile.stderr.text).toBe(clean.stderr.text);
  });

  it("records nothing when the user opted out via DO_NOT_TRACK", async () => {
    const { events, sink } = capturingSink();
    const capture = createCapture(["check"]);

    await runCli(
      { ...distro([findingPlugin("info", [])]), telemetry: sink },
      {
        ...capture.runtime,
        environmentVariables: { DO_NOT_TRACK: "1", PATH: "/usr/bin" },
        now: CLOCK,
      },
    );

    expect(events).toEqual([]);
  });

  it("records nothing for --explain and usage rejections", async () => {
    const { events, sink } = capturingSink();

    const explain = createCapture(["check", "--explain", "fixture-info/INFO"]);
    await runCli(
      { ...distro([findingPlugin("info", [])]), telemetry: sink },
      { ...explain.runtime, now: CLOCK },
    );

    const rejected = createCapture(["check", "--json-version", "1"]);
    await runCli(
      { ...distro([findingPlugin("info", [])]), telemetry: sink },
      { ...rejected.runtime, now: CLOCK },
    );

    expect(events).toEqual([]);
  });
});
