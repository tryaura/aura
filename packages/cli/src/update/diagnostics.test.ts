import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { createUpdateDebug, startUpdateProgress } from "./diagnostics.js";
import { eraseFrame } from "../terminal-frame.js";
import type { CliUpdates } from "./types.js";

const UPDATES: CliUpdates = {
  disableEnvironmentVariable: "ACME_UPDATE",
  source: {
    apiBaseUrl: "https://api.github.com",
    kind: "github-release",
    owner: "acme",
    repository: "acme-cli",
    requireImmutable: true,
  },
};

describe("update trace", () => {
  it.each(["1", "on", "true", "yes", "TRUE", " on "])("writes when the variable is %s", (value) => {
    const stderr = capture();
    createUpdateDebug(UPDATES, { ACME_UPDATE_DEBUG: value }, stderr.stream)("skipped: disabled");

    expect(stderr.text()).toBe("update: skipped: disabled\n");
  });

  /**
   * Off is the default and the only state a user ever sees. A distribution that declares no
   * updates has no variable to name, so it cannot be turned on at all.
   */
  it.each([
    { label: "the variable is unset", updates: UPDATES, variables: {} },
    { label: "the variable is off", updates: UPDATES, variables: { ACME_UPDATE_DEBUG: "0" } },
    { label: "another distribution's variable is on", updates: UPDATES, variables: { OTHER: "1" } },
    {
      label: "there is no update source",
      updates: undefined,
      variables: { ACME_UPDATE_DEBUG: "1" },
    },
  ])("stays silent when $label", ({ updates, variables }) => {
    const stderr = capture();
    createUpdateDebug(updates, variables, stderr.stream)("skipped: disabled");

    expect(stderr.text()).toBe("");
  });
});

describe("download progress", () => {
  /**
   * A frame nobody can erase is a frame that survives into the report, so a stream that is not a
   * terminal gets no callback at all rather than a line it cannot take back.
   */
  it("paints nothing without a terminal to paint on", () => {
    const stderr = new PassThrough();
    const progress = startUpdateProgress(stderr);

    expect(progress.report).toBeUndefined();
  });

  it("repaints in place and leaves nothing behind", () => {
    const stderr = capture();
    const progress = startUpdateProgress(stderr.stream);

    progress.report?.(20, 100);
    progress.report?.(60, 100);
    progress.close();

    expect(stderr.text()).toBe(
      `  Downloading… 20%\n${eraseFrame(1)}  Downloading… 60%\n${eraseFrame(1)}`,
    );
  });

  it("never claims to be finished before the last byte lands", () => {
    const stderr = capture();
    const progress = startUpdateProgress(stderr.stream);

    progress.report?.(100, 100);

    expect(stderr.text()).toContain("99%");
  });

  it("ignores reports that arrive after it has been taken down", () => {
    const stderr = capture();
    const progress = startUpdateProgress(stderr.stream);

    progress.close();
    progress.close();
    progress.report?.(50, 100);

    expect(stderr.text()).toBe("");
  });
});

function capture(): { readonly stream: PassThrough; readonly text: () => string } {
  const chunks: string[] = [];
  const stream = Object.assign(new PassThrough(), { isTTY: true });
  stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
  return { stream, text: () => chunks.join("") };
}
