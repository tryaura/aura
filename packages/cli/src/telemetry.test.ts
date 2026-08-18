import { setTimeout as delay } from "node:timers/promises";

import type { CommandFailedEvent, TelemetryEvent, TelemetrySink } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { createTelemetryRecorder, telemetryEnabled } from "./telemetry.js";

const DRAFT: Omit<CommandFailedEvent, "at" | "distroVersion"> = {
  command: "check",
  exitCode: 3,
  kind: "command-failed",
};

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

describe("createTelemetryRecorder", () => {
  it("does nothing without a sink", async () => {
    const recorder = createTelemetryRecorder({
      distroVersion: "1.0.0",
      now: () => new Date(0),
      sink: undefined,
    });
    recorder.record(DRAFT);
    await expect(recorder.flush()).resolves.toBeUndefined();
  });

  it("stamps the time from the injected clock and the distribution version", () => {
    const { events, sink } = capturingSink();
    const recorder = createTelemetryRecorder({
      distroVersion: "1.2.3",
      now: () => new Date("2026-08-18T12:00:00.000Z"),
      sink,
    });

    recorder.record(DRAFT);

    expect(events).toEqual([
      {
        at: "2026-08-18T12:00:00.000Z",
        command: "check",
        distroVersion: "1.2.3",
        exitCode: 3,
        kind: "command-failed",
      },
    ]);
  });

  it("omits the version when the distribution declares none", () => {
    const { events, sink } = capturingSink();
    const recorder = createTelemetryRecorder({
      distroVersion: undefined,
      now: () => new Date(0),
      sink,
    });

    recorder.record(DRAFT);

    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty("distroVersion");
  });

  it("swallows a sink whose record throws", () => {
    const recorder = createTelemetryRecorder({
      distroVersion: undefined,
      now: () => new Date(0),
      sink: {
        flush: () => Promise.resolve(),
        record: () => {
          throw new Error("sink bug");
        },
      },
    });

    expect(() => {
      recorder.record(DRAFT);
    }).not.toThrow();
  });

  it("swallows a sink whose flush rejects", async () => {
    const recorder = createTelemetryRecorder({
      distroVersion: undefined,
      now: () => new Date(0),
      sink: {
        flush: () => Promise.reject(new Error("sink bug")),
        record: () => undefined,
      },
    });

    await expect(recorder.flush()).resolves.toBeUndefined();
  });

  it("bounds a flush that never settles", async () => {
    let aborted = false;
    const recorder = createTelemetryRecorder({
      distroVersion: undefined,
      flushTimeoutMs: 20,
      now: () => new Date(0),
      sink: {
        flush: (signal) =>
          new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                resolve();
              },
              { once: true },
            );
          }),
        record: () => undefined,
      },
    });

    let flushed = false;
    const flushing = recorder.flush().then(() => {
      flushed = true;
    });
    await delay(100);
    expect(flushed).toBe(true);
    expect(aborted).toBe(true);
    await flushing;
  });
});

describe("telemetryEnabled", () => {
  it("is on by default", () => {
    expect(telemetryEnabled({})).toBe(true);
  });

  it("is off when DO_NOT_TRACK is set", () => {
    expect(telemetryEnabled({ DO_NOT_TRACK: "1" })).toBe(false);
    expect(telemetryEnabled({ DO_NOT_TRACK: "true" })).toBe(false);
  });

  it("treats DO_NOT_TRACK zero and empty as unset", () => {
    expect(telemetryEnabled({ DO_NOT_TRACK: "0" })).toBe(true);
    expect(telemetryEnabled({ DO_NOT_TRACK: "" })).toBe(true);
  });

  it("is off when AURA_TELEMETRY is off", () => {
    expect(telemetryEnabled({ AURA_TELEMETRY: "off" })).toBe(false);
    expect(telemetryEnabled({ AURA_TELEMETRY: "on" })).toBe(true);
  });
});
