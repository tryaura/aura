import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFileReader } from "../workspace/reader.js";
import { analyzeCodexSessions } from "./codex-analyze.js";
import type { CodexTranscriptReader } from "./codex-transcript-reader.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Codex analysis coverage", () => {
  it("marks a recognized session partial when its transcript stream does not complete", async () => {
    const home = await mkdtemp(join(tmpdir(), "aura-session-coverage-"));
    temporaryDirectories.push(home);
    const directory = join(home, ".codex", "sessions", "2026", "08", "21");
    await mkdir(directory, { recursive: true });
    const record = JSON.stringify({
      payload: { cwd: "/repo/one", id: "s1" },
      timestamp: "2026-08-21T10:00:00.000Z",
      type: "session_meta",
    });
    await writeFile(join(directory, "a.jsonl"), `${record}\n`);
    const transcriptReader: CodexTranscriptReader = async () => ({
      completed: () => false,
      lines: streamLines([record]),
      size: 100,
    });

    const analysis = await analyzeCodexSessions({
      days: 7,
      homeDir: home,
      now: new Date("2026-08-25T12:00:00.000Z"),
      reader: createFileReader(),
      transcriptReader,
    });

    expect(analysis.partialFiles).toBe(1);
    expect(analysis.readErrorFiles).toBe(1);
    expect(analysis.sessions[0]?.partial).toBe(true);
    expect(analysis.sessions[0]?.readError).toBe(true);
    expect(analysis.repos[0]?.partialSessions).toBe(1);
  });
});

async function* streamLines(lines: readonly string[]): AsyncIterable<string> {
  for (const line of lines) {
    yield line;
  }
}
