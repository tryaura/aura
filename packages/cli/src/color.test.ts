import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { detectColorDepth, extractColorArguments } from "./color.js";

interface ColorCase {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly expected: number;
  readonly name: string;
  readonly tty: boolean;
}

describe("color decision", () => {
  it.each<ColorCase>([
    { environment: { NO_COLOR: "1", FORCE_COLOR: "1" }, expected: 0, name: "NO_COLOR", tty: true },
    { environment: { FORCE_COLOR: "0" }, expected: 0, name: "FORCE_COLOR=0", tty: true },
    { environment: { CI: "1", FORCE_COLOR: "1" }, expected: 8, name: "forced CI", tty: false },
    { environment: { FORCE_COLOR: "2" }, expected: 8, name: "positive FORCE_COLOR", tty: false },
    { environment: { CI: "true" }, expected: 0, name: "automatic CI", tty: true },
    { environment: { CI: "false" }, expected: 8, name: "CI switched off", tty: true },
    { environment: { CI: "0" }, expected: 8, name: "CI zeroed", tty: true },
    { environment: { TERM: "dumb" }, expected: 0, name: "dumb terminal", tty: true },
    { environment: { TERM: "xterm-256color" }, expected: 8, name: "terminal", tty: true },
    { environment: {}, expected: 0, name: "pipe", tty: false },
    {
      environment: { NO_COLOR: "", TERM: "xterm" },
      expected: 8,
      name: "empty NO_COLOR",
      tty: true,
    },
  ])("resolves $name", ({ environment, expected, tty }) => {
    expect(detectColorDepth(environment, output(tty))).toBe(expected);
  });

  it("consumes --no-color only before the positional separator", () => {
    expect(
      extractColorArguments(["--no-color", "check", "--no-color", "--", "--no-color"]),
    ).toEqual({
      argv: ["check", "--", "--no-color"],
      noColor: true,
    });
    expect(extractColorArguments(["undo", "--", "--no-color"])).toEqual({
      argv: ["undo", "--", "--no-color"],
      noColor: false,
    });
  });
});

function output(isTTY: boolean): Writable {
  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  Object.defineProperty(stream, "isTTY", { value: isTTY });
  return stream;
}
