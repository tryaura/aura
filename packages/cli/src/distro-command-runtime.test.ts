import type { TelemetryEvent, TelemetrySink } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { runCli } from "./index.js";
import { BRANDING, createCapture } from "./testing.js";
import type { CliCommandDefinition, CliCommandInvocation, CliDistro } from "./types.js";

/**
 * What one distribution command's invocation carries: the run's injected `Environment` and a
 * telemetry channel scoped to its own word. Parsing, help, and validation live in
 * `distro-command.test.ts`.
 */

const NOW = "2026-08-24T10:00:00.000Z";

/** The fixture command these cases share, carrying one flag so a run has something to report. */
function syncCommand(execute: CliCommandDefinition["execute"]): CliCommandDefinition {
  return {
    execute,
    flags: [{ description: "Sync even when nothing changed", flag: "--force", kind: "boolean" }],
    summary: "Synchronize agent profiles",
    word: "sync",
  };
}

/** A distribution whose sink collects into `events`, so a run's telemetry is assertable. */
function recordingDistro(
  execute: CliCommandDefinition["execute"],
  events: TelemetryEvent[],
): CliDistro {
  const telemetry: TelemetrySink = {
    flush: () => Promise.resolve(),
    record: (event) => {
      events.push(event);
    },
  };
  return { branding: BRANDING, commands: [syncCommand(execute)], plugins: [], telemetry };
}

describe("distribution command environment", () => {
  it("injects the run's environment rather than the surrounding process", async () => {
    const invocations: CliCommandInvocation[] = [];
    const capture = createCapture(["sync"]);

    await runCli(
      {
        branding: BRANDING,
        commands: [
          syncCommand((invocation) => {
            invocations.push(invocation);
            return Promise.resolve(0);
          }),
        ],
        plugins: [],
      },
      { ...capture.runtime, now: () => new Date(NOW) },
    );

    const environment = invocations[0]?.environment;
    expect(environment?.cwd).toBe(capture.runtime.cwd);
    expect(environment?.homeDir).toBe("/fixture/home");
    expect(environment?.readVariable("PATH")).toBe("/usr/bin");
    expect(environment?.pathEntries).toEqual(["/usr/bin"]);
    expect(environment?.now().toISOString()).toBe(NOW);
    expect(typeof environment?.exec).toBe("function");
    expect(typeof environment?.httpGet).toBe("function");
  });
});

describe("distribution command telemetry", () => {
  it("stamps the command word, kind, time, and version onto a recorded event", async () => {
    const events: TelemetryEvent[] = [];
    const capture = createCapture(["sync", "--force"]);

    const exitCode = await runCli(
      recordingDistro((invocation) => {
        invocation.telemetry.record({
          counts: { profiles: 4 },
          durationMs: 12,
          event: "sync-run",
          exitCode: 0,
          flags: { force: invocation.flags["--force"] === true },
          outcome: "applied",
        });
        return Promise.resolve(0);
      }, events),
      { ...capture.runtime, now: () => new Date(NOW) },
    );

    expect(exitCode).toBe(0);
    expect(events).toEqual([
      {
        at: NOW,
        command: "sync",
        counts: { profiles: 4 },
        distroVersion: "1.2.3",
        durationMs: 12,
        event: "sync-run",
        exitCode: 0,
        flags: { force: true },
        kind: "distro-command",
        outcome: "applied",
      },
    ]);
  });

  it("refuses an event a command tried to attribute to another command", async () => {
    const events: TelemetryEvent[] = [];
    const capture = createCapture(["sync"]);

    await runCli(
      recordingDistro((invocation) => {
        // A definition reaches `record` only through the draft type, so forging the envelope takes
        // a cast — and the word the CLI stamps still wins.
        invocation.telemetry.record({ command: "check", event: "sync-run" } as never);
        return Promise.resolve(0);
      }, events),
      capture.runtime,
    );

    expect(events[0]?.command).toBe("sync");
    expect(events[0]?.kind).toBe("distro-command");
  });

  it("drops an event a command records under the reserved command-failed label", async () => {
    const events: TelemetryEvent[] = [];
    const capture = createCapture(["sync"]);

    await runCli(
      recordingDistro((invocation) => {
        invocation.telemetry.record({ event: "command-failed", exitCode: 0 });
        invocation.telemetry.record({ event: "sync-run" });
        return Promise.resolve(0);
      }, events),
      capture.runtime,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: "sync-run", kind: "distro-command" });
  });

  it("records nothing when the user opted out", async () => {
    const events: TelemetryEvent[] = [];
    const capture = createCapture(["sync"]);

    await runCli(
      recordingDistro((invocation) => {
        invocation.telemetry.record({ event: "sync-run" });
        return Promise.resolve(0);
      }, events),
      { ...capture.runtime, environmentVariables: { DO_NOT_TRACK: "1", PATH: "/usr/bin" } },
    );

    expect(events).toEqual([]);
  });

  it("records the failure of a throwing command without its error text", async () => {
    const events: TelemetryEvent[] = [];
    const capture = createCapture(["sync"]);

    const exitCode = await runCli(
      recordingDistro(() => Promise.reject(new Error("/home/ana/.secrets unreachable")), events),
      capture.runtime,
    );

    expect(exitCode).toBe(3);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      command: "sync",
      event: "command-failed",
      exitCode: 3,
      kind: "distro-command",
    });
    expect(JSON.stringify(events[0])).not.toContain("secrets");
  });
});
