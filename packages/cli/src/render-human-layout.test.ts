import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { pinnedRow, reportColumns, rightAligned } from "./render-human-layout.js";
import { displayWidth } from "./text-width.js";

/** A stream that either reports a terminal width or, like a redirect, reports none. */
function stream(columns?: number): Writable {
  const target = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  return columns === undefined ? target : Object.assign(target, { columns });
}

describe("reportColumns", () => {
  it("takes the default when the stream reports no width of its own", () => {
    expect(reportColumns(stream())).toBe(80);
  });

  it("follows a terminal that reports a width inside the bounds", () => {
    expect(reportColumns(stream(64))).toBe(64);
  });

  it("clamps a very wide terminal so the pinned column stays near its text", () => {
    expect(reportColumns(stream(220))).toBe(100);
  });

  it("clamps a very narrow terminal to the width alignment still survives", () => {
    expect(reportColumns(stream(12))).toBe(40);
  });

  it("ignores a width no terminal could have", () => {
    expect(reportColumns(stream(0))).toBe(80);
  });
});

describe("pinnedRow", () => {
  it("holds the pinned value at the report's right edge", () => {
    const [row] = pinnedRow({ indent: "  ", pinned: "MCP-004", text: "hello", width: 40 });

    expect(row).toBe(`  hello${" ".repeat(26)}MCP-004`);
    expect(displayWidth(row ?? "")).toBe(40);
  });

  it("wraps at word boundaries and keeps the pin on the first row", () => {
    const rows = pinnedRow({
      indent: "  ",
      pinned: "MCP-004",
      text: "MCP server context7 stores a credential inline at args[3].",
      width: 40,
    });

    expect(rows).toEqual([
      "  MCP server context7 stores a   MCP-004",
      "  credential inline at args[3].",
    ]);
    expect(displayWidth(rows[0] ?? "")).toBe(40);
  });

  it("indents wrapped rows under their own level", () => {
    const rows = pinnedRow({
      continuationIndent: "      ",
      indent: "    ",
      text: "one two three four five six seven eight nine ten eleven twelve",
      width: 40,
    });

    expect(rows[0]?.startsWith("    one")).toBe(true);
    expect(rows.slice(1).every((row) => row.startsWith("      "))).toBe(true);
    expect(rows.every((row) => displayWidth(row) <= 40)).toBe(true);
  });

  it("measures wide characters as the columns they occupy", () => {
    const [row] = pinnedRow({ indent: "", pinned: "ID", text: "日本語", width: 20 });

    expect(displayWidth(row ?? "")).toBe(20);
    expect(row).toBe(`日本語${" ".repeat(12)}ID`);
  });

  it("hard-breaks a single word too wide to word-wrap", () => {
    const rows = pinnedRow({
      indent: "  ",
      text: "/very/long/path/segment/that/cannot/be/worded/around/at/all.json",
      width: 40,
    });

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => displayWidth(row) <= 40)).toBe(true);
    expect(rows.join("").replaceAll(" ", "")).toBe(
      "/very/long/path/segment/that/cannot/be/worded/around/at/all.json",
    );
  });

  it("drops a pinned value to its own line when it would crowd out the text", () => {
    const rows = pinnedRow({
      indent: "  ",
      pinned: "a-very-long-plugin-namespaced-check-id",
      text: "Short message.",
      width: 40,
    });

    expect(rows).toEqual(["  Short message.", "  a-very-long-plugin-namespaced-check-id"]);
    expect(displayWidth(rows[1] ?? "")).toBe(40);
  });

  it("styles each line after wrapping, so decoration never disturbs alignment", () => {
    const rows = pinnedRow({
      decorate: (line) => `[31m${line}[39m`,
      indent: "  ",
      pinned: "MCP-004",
      text: "MCP server context7 stores a credential inline at args[3].",
      width: 40,
    });

    expect(rows[0]).toContain("[31m");
    expect(displayWidth(rows[0] ?? "")).toBe(40);
    expect(rows[1]).toContain("[31m");
  });
});

describe("rightAligned", () => {
  it("pads a value out to the report's edge", () => {
    expect(rightAligned("2 warnings", 20)).toBe(`${" ".repeat(10)}2 warnings`);
  });

  it("leaves a value wider than the report alone", () => {
    expect(rightAligned("2 warnings", 4)).toBe("2 warnings");
  });
});
