import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { startScanProgress } from "./scan-progress.js";

/** A stream that records what a frame wrote, standing in for a terminal or a redirect. */
function stream(isTTY: boolean, columns = 80): Writable & { readonly written: string[] } {
  const written: string[] = [];
  const target = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      written.push(String(chunk));
      callback();
    },
  });
  return Object.assign(target, isTTY ? { columns, isTTY, written } : { written });
}

const ROWS = [
  { id: "claude-code", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
];

describe("startScanProgress", () => {
  it("paints one row per application as soon as it starts", () => {
    const stdout = stream(true);

    const progress = startScanProgress({ colorDepth: 0, rows: ROWS, stdout });
    progress.close();

    expect(stdout.written[0]).toContain("Scanning this machine…");
    expect(stdout.written[0]).toContain("☐ Claude Code");
    expect(stdout.written[0]).toContain("☐ Cursor");
  });

  it("marks a settled application done and leaves the rest waiting", () => {
    const stdout = stream(true);

    const progress = startScanProgress({ colorDepth: 0, rows: ROWS, stdout });
    progress.report("claude-code", "active");
    progress.report("claude-code", "complete");
    const frame = stdout.written.at(-1) ?? "";
    progress.close();

    expect(frame).toContain("✔ Claude Code");
    expect(frame).toContain("☐ Cursor");
  });

  it("erases everything it painted, so the report starts on a clean screen", () => {
    const stdout = stream(true);

    const progress = startScanProgress({ colorDepth: 0, rows: ROWS, stdout });
    progress.close();

    expect(stdout.written.at(-1)).toBe("\u001b[6A\r\u001b[0J");
  });

  it("recounts wrapped rows before repainting after the terminal narrows", () => {
    const stdout = stream(true);

    const progress = startScanProgress({ colorDepth: 0, rows: ROWS, stdout });
    Object.assign(stdout, { columns: 20 });
    stdout.emit("resize");
    const repaint = stdout.written.at(-1) ?? "";
    progress.close();

    expect(repaint.startsWith("\u001b[7A\r\u001b[0J")).toBe(true);
  });

  it("closes once, however many times it is asked", () => {
    const stdout = stream(true);

    const progress = startScanProgress({ colorDepth: 0, rows: ROWS, stdout });
    progress.close();
    const afterFirst = stdout.written.length;
    progress.close();
    progress.report("cursor", "complete");
    stdout.emit("resize");

    expect(stdout.written).toHaveLength(afterFirst);
  });

  it("writes nothing at all when the output is redirected", () => {
    const stdout = stream(false);

    const progress = startScanProgress({ colorDepth: 0, rows: ROWS, stdout });
    progress.report("cursor", "complete");
    progress.close();

    expect(stdout.written).toEqual([]);
  });

  it("writes nothing when there is no application to wait on", () => {
    const stdout = stream(true);

    const progress = startScanProgress({ colorDepth: 0, rows: [], stdout });
    progress.close();

    expect(stdout.written).toEqual([]);
  });

  it("ignores an adapter it was never told to show", () => {
    const stdout = stream(true);

    const progress = startScanProgress({ colorDepth: 0, rows: ROWS, stdout });
    const painted = stdout.written.length;
    progress.report("codex", "complete");
    progress.close();

    expect(stdout.written).toHaveLength(painted + 1);
  });
});
