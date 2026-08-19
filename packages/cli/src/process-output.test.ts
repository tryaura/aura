import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { resolveProcessOutput } from "./process-output.js";

describe("process output guards", () => {
  it("never changes an injected output stream", () => {
    const injected = output();
    const fallback = output();

    expect(resolveProcessOutput(injected, fallback, noop)).toBe(injected);
    expect(injected.listenerCount("error")).toBe(0);
    expect(fallback.listenerCount("error")).toBe(0);
  });

  it("installs one guard on a process-owned output and keeps it current", () => {
    const fallback = output();
    const first: unknown[] = [];
    const second: unknown[] = [];
    const failure = new Error("out of space");

    expect(
      resolveProcessOutput(undefined, fallback, (error) => {
        first.push(error);
      }),
    ).toBe(fallback);
    expect(
      resolveProcessOutput(undefined, fallback, (error) => {
        second.push(error);
      }),
    ).toBe(fallback);
    fallback.emit("error", failure);

    expect(fallback.listenerCount("error")).toBe(1);
    expect(first).toEqual([]);
    expect(second).toEqual([failure]);
  });

  it("swallows a reader closing the pipe and reports every other failure", () => {
    const fallback = output();
    const reported: unknown[] = [];
    const closedPipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    const broken = Object.assign(new Error("write ENOSPC"), { code: "ENOSPC" });

    resolveProcessOutput(undefined, fallback, (error) => {
      reported.push(error);
    });
    fallback.emit("error", closedPipe);
    fallback.emit("error", broken);

    expect(reported).toEqual([broken]);
  });
});

function noop(): void {
  // A guard the assertion never reaches.
}

function output(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}
