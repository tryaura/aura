import type { HttpPostRequest, TelemetryEvent } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import {
  createHttpTelemetrySink,
  type HttpTelemetryDeliveryFailure,
} from "./http-telemetry-sink.js";

function event(exitCode: number): TelemetryEvent {
  return { at: "2026-08-18T12:00:00.000Z", command: "check", exitCode, kind: "command-failed" };
}

function activeSignal(): AbortSignal {
  return new AbortController().signal;
}

function eventCount(body: string): number {
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== "object" || parsed === null || !("events" in parsed)) {
    throw new Error("Telemetry body has no events property.");
  }
  if (!Array.isArray(parsed.events)) {
    throw new Error("Telemetry events property is not an array.");
  }
  return parsed.events.length;
}

describe("createHttpTelemetrySink", () => {
  it("buffers on record and delivers everything as one JSON document on flush", async () => {
    const posts: HttpPostRequest[] = [];
    const sink = createHttpTelemetrySink({
      headers: { Authorization: "Bearer org-token" },
      post: (request) => {
        posts.push(request);
        return Promise.resolve({ kind: "response", status: 202 });
      },
      url: "https://telemetry.example.com/events",
    });

    sink.record(event(0));
    sink.record(event(1));
    expect(posts).toHaveLength(0);

    const controller = new AbortController();
    await sink.flush(controller.signal);

    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe("https://telemetry.example.com/events");
    expect(posts[0]?.headers).toEqual({ Authorization: "Bearer org-token" });
    expect(posts[0]?.signal).toBe(controller.signal);
    expect(JSON.parse(posts[0]?.body ?? "")).toEqual({
      events: [event(0), event(1)],
      kind: "aura-telemetry",
      schemaVersion: 1,
    });
  });

  it("splits deliveries into batches of maxBatch", async () => {
    const posts: HttpPostRequest[] = [];
    const sink = createHttpTelemetrySink({
      maxBatch: 2,
      post: (request) => {
        posts.push(request);
        return Promise.resolve({ kind: "response", status: 200 });
      },
      url: "https://telemetry.example.com/events",
    });

    for (let index = 0; index < 5; index += 1) {
      sink.record(event(index));
    }
    await sink.flush(activeSignal());

    const sizes = posts.map((post) => eventCount(post.body));
    expect(sizes).toEqual([2, 2, 1]);
  });

  it("drops events beyond the buffer cap without throwing", async () => {
    const posts: HttpPostRequest[] = [];
    const sink = createHttpTelemetrySink({
      maxBufferedEvents: 3,
      post: (request) => {
        posts.push(request);
        return Promise.resolve({ kind: "response", status: 200 });
      },
      url: "https://telemetry.example.com/events",
    });

    for (let index = 0; index < 10; index += 1) {
      sink.record(event(index));
    }
    await sink.flush(activeSignal());

    expect(posts).toHaveLength(1);
    expect(eventCount(posts[0]?.body ?? "")).toBe(3);
  });

  it("reports transport failures, non-2xx statuses, and a rejecting transport", async () => {
    let call = 0;
    const failures: HttpTelemetryDeliveryFailure[] = [];
    const sink = createHttpTelemetrySink({
      maxBatch: 1,
      onDeliveryFailure: (failure) => {
        failures.push(failure);
      },
      post: () => {
        call += 1;
        if (call === 1) {
          return Promise.resolve({ kind: "failure", reason: "network" });
        }
        if (call === 2) {
          return Promise.resolve({ kind: "response", status: 500 });
        }
        return Promise.reject(new Error("injected transport bug"));
      },
      url: "https://telemetry.example.com/events",
    });

    sink.record(event(0));
    sink.record(event(1));
    sink.record(event(2));

    await expect(sink.flush(activeSignal())).resolves.toBeUndefined();
    expect(call).toBe(3);
    expect(failures).toEqual([
      { kind: "transport", reason: "network" },
      { kind: "http-status", status: 500 },
      { kind: "transport", reason: "rejected" },
    ]);
  });

  it("flushes nothing when nothing was recorded, and does not resend after a flush", async () => {
    const posts: HttpPostRequest[] = [];
    const sink = createHttpTelemetrySink({
      post: (request) => {
        posts.push(request);
        return Promise.resolve({ kind: "response", status: 200 });
      },
      url: "https://telemetry.example.com/events",
    });

    await sink.flush(activeSignal());
    expect(posts).toHaveLength(0);

    sink.record(event(0));
    await sink.flush(activeSignal());
    await sink.flush(activeSignal());
    expect(posts).toHaveLength(1);
  });

  it("stops before delivery when the flush signal is already aborted", async () => {
    let calls = 0;
    const sink = createHttpTelemetrySink({
      maxBatch: 1,
      post: () => {
        calls += 1;
        return Promise.resolve({ kind: "response", status: 200 });
      },
      url: "https://telemetry.example.com/events",
    });
    sink.record(event(0));

    const controller = new AbortController();
    controller.abort();
    await sink.flush(controller.signal);

    expect(calls).toBe(0);
  });

  it("validates endpoint and numeric options at construction", () => {
    expect(() => createHttpTelemetrySink({ url: "not a url" })).toThrow(/absolute/u);
    expect(() => createHttpTelemetrySink({ url: "http://telemetry.example.com/events" })).toThrow(
      /https/u,
    );
    expect(() =>
      createHttpTelemetrySink({ url: "https://user:secret@telemetry.example.com/events" }),
    ).toThrow(/credentials/u);
    expect(() =>
      createHttpTelemetrySink({ maxBatch: 1.5, url: "https://telemetry.example.com/events" }),
    ).toThrow(/positive safe integer/u);
    expect(() =>
      createHttpTelemetrySink({ timeoutMs: 0, url: "https://telemetry.example.com/events" }),
    ).toThrow(/positive finite number/u);
  });

  it("swallows a delivery observer that throws", async () => {
    const sink = createHttpTelemetrySink({
      onDeliveryFailure: () => {
        throw new Error("observer bug");
      },
      post: () => Promise.resolve({ kind: "failure", reason: "network" }),
      url: "https://telemetry.example.com/events",
    });
    sink.record(event(0));

    await expect(sink.flush(activeSignal())).resolves.toBeUndefined();
  });
});
