import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createCodexTranscriptReader } from "./codex-transcript-reader.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Codex transcript reader", () => {
  it("streams complete lines and drops a byte-capped partial line", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aura-transcript-reader-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "rollout.jsonl");
    await writeFile(path, "first\nsecond\nthird");
    const reader = createCodexTranscriptReader();

    const transcript = await reader(path, 9);
    const lines: string[] = [];
    if (transcript !== undefined) {
      for await (const line of transcript.lines) {
        lines.push(line);
      }
    }

    expect(transcript?.size).toBe(18);
    expect(lines).toEqual(["first"]);
  });

  it("keeps the final line when the whole file fits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aura-transcript-reader-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "rollout.jsonl");
    await writeFile(path, "first\nsecond");
    const reader = createCodexTranscriptReader();

    const transcript = await reader(path, 100);
    const lines: string[] = [];
    if (transcript !== undefined) {
      for await (const line of transcript.lines) {
        lines.push(line);
      }
    }

    expect(lines).toEqual(["first", "second"]);
  });

  it("finds a newline after a record spans multiple read buffers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aura-transcript-reader-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "rollout.jsonl");
    const first = "x".repeat(70_000);
    await writeFile(path, `${first}\nsecond`);
    const reader = createCodexTranscriptReader();

    const transcript = await reader(path, 100_000);
    const lines: string[] = [];
    if (transcript !== undefined) {
      for await (const line of transcript.lines) {
        lines.push(line);
      }
    }

    expect(lines).toEqual([first, "second"]);
  });
});
