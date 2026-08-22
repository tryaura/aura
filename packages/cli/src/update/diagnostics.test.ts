import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  createUpdateDebug,
  startUpdateProgress,
  updateEnvironmentVariable,
} from "./diagnostics.js";
import { eraseFrame } from "../terminal-frame.js";

const DISABLE_VARIABLE = "ACME_UPDATE";

describe("update trace", () => {
  it.each(["1", "on", "true", "yes", "TRUE", " on "])("writes when the variable is %s", (value) => {
    const stderr = capture();
    createUpdateDebug(
      DISABLE_VARIABLE,
      { ACME_UPDATE_DEBUG: value },
      stderr.stream,
    )("skipped: disabled");

    expect(stderr.text()).toBe("update: skipped: disabled\n");
  });

  /**
   * Off is the default and the only state a user ever sees.
   */
  it.each([
    { label: "the variable is unset", variables: {} },
    { label: "the variable is off", variables: { ACME_UPDATE_DEBUG: "0" } },
    { label: "another distribution's variable is on", variables: { OTHER: "1" } },
  ])("stays silent when $label", ({ variables }) => {
    const stderr = capture();
    createUpdateDebug(DISABLE_VARIABLE, variables, stderr.stream)("skipped: disabled");

    expect(stderr.text()).toBe("");
  });

  it("derives distribution-specific disable and debug variable names", () => {
    expect(updateEnvironmentVariable("acme-dev.cli")).toBe("ACME_DEV_CLI_UPDATE");
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
