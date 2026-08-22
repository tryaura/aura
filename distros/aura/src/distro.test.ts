import type { CommandFailedEvent, HttpPostRequest } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { AURA_DISTRO, createAuraDistro } from "./distro.js";

const EVENT: CommandFailedEvent = {
  at: "2026-08-22T12:34:56.000Z",
  command: "check",
  exitCode: 3,
  kind: "command-failed",
};

describe("official Aura telemetry", () => {
  it("keeps the repository build offline", () => {
    expect(AURA_DISTRO.branding.version).toBe("0.0.0");
    expect(AURA_DISTRO.telemetry).toBeUndefined();
    expect(createAuraDistro({ version: "0.0.0" }).telemetry).toBeUndefined();
  });

  it("delivers stamped release events to the fixed endpoint under the release bounds", async () => {
    const posts: HttpPostRequest[] = [];
    const distro = createAuraDistro({
      telemetryPost: (request) => {
        posts.push(request);
        return Promise.resolve({ kind: "response", status: 202 });
      },
      version: "1.2.3",
    });
    const telemetry = distro.telemetry;
    if (telemetry === undefined) {
      throw new Error("A stamped release did not compose telemetry.");
    }

    for (let index = 0; index < 6; index += 1) {
      telemetry.record(EVENT);
    }
    await telemetry.flush(new AbortController().signal);

    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      timeoutMs: 250,
      url: "https://tryaura.sh/api/telemetry/v1",
    });
    const body: unknown = JSON.parse(posts[0]?.body ?? "");
    expect(body).toEqual({
      events: Array.from({ length: 5 }, () => EVENT),
      kind: "aura-telemetry",
      schemaVersion: 1,
    });
  });
});
