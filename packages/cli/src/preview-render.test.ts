import { Writable } from "node:stream";

import type { FixOperationPreview } from "@tryaura/core";
import { describe, expect, it } from "vitest";

import { renderOperationPreviews } from "./preview-render.js";

describe("renderOperationPreviews", () => {
  it("calls an archived replacement an update", () => {
    const path = "/home/dev/agents/AGENTS.md";
    const operation: FixOperationPreview = {
      diff: "",
      effect: "archive",
      index: 0,
      operation: {
        path,
        relativePath: "home/agents/AGENTS.md",
        replacement: { content: "merged\n", type: "write" },
        type: "archive",
      },
      paths: [path],
    };
    const output = new TextOutput();

    renderOperationPreviews([operation], false, output);

    expect(output.text).toBe(`  update ${path}\n`);
  });

  it("still calls an archive without a replacement an archive", () => {
    const path = "/home/dev/.claude/CLAUDE.md";
    const operation: FixOperationPreview = {
      diff: "",
      effect: "archive",
      index: 0,
      operation: { path, relativePath: "home/.claude/CLAUDE.md", type: "archive" },
      paths: [path],
    };
    const output = new TextOutput();

    renderOperationPreviews([operation], false, output);

    expect(output.text).toBe(`  archive ${path}\n`);
  });
});

class TextOutput extends Writable {
  text = "";

  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.text += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    callback();
  }
}
