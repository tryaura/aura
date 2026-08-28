import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import { createFileReader, type FileReader, type PathContents } from "../workspace/reader.js";
import { analyzeClaudeSessions } from "./claude-analyze.js";
import { discoverClaudeSessions } from "./claude-discover.js";
import type { SessionAnalysis } from "./session-metrics.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function createHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "aura-sessions-"));
  temporaryDirectories.push(home);
  return home;
}

async function writeTranscript(
  home: string,
  project: string,
  name: string,
  lines: readonly string[],
): Promise<string> {
  const directory = join(home, ".claude", "projects", project);
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await writeFile(path, `${lines.join("\n")}\n`);
  return path;
}

function transcript(sessionId: string, cwd: string, day: string): readonly string[] {
  return [
    JSON.stringify({ aiTitle: "some work", sessionId, type: "ai-title" }),
    JSON.stringify({
      cwd,
      isSidechain: false,
      message: { content: "do the work", role: "user" },
      promptSource: "typed",
      sessionId,
      timestamp: `${day}T10:00:00.000Z`,
      type: "user",
      uuid: "uuid-1",
    }),
    JSON.stringify({
      cwd,
      isSidechain: false,
      message: {
        content: [{ text: "done", type: "text" }],
        id: "msg-1",
        model: "claude-opus-5",
        role: "assistant",
        stop_reason: "end_turn",
        usage: {
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 40,
          input_tokens: 10,
          output_tokens: 5,
        },
      },
      sessionId,
      timestamp: `${day}T10:00:10.000Z`,
      type: "assistant",
      uuid: "uuid-2",
    }),
  ];
}

function analyze(home: string): Promise<SessionAnalysis> {
  return analyzeClaudeSessions({
    days: 30,
    homeDir: home,
    now: new Date("2026-08-21T12:00:00.000Z"),
    reader: createFileReader(),
  });
}

describe("analyzeClaudeSessions", () => {
  it("finds transcripts under ~/.claude/projects and sums their sessions", async () => {
    const home = await createHome();
    await writeTranscript(
      home,
      "-repo-app",
      "aaa.jsonl",
      transcript("s-1", "/repo/app", "2026-08-20"),
    );

    const analysis = await analyze(home);

    expect(analysis.scannedFiles).toBe(1);
    expect(analysis.sources).toEqual(["claude-code"]);
    expect(analysis.sessions).toHaveLength(1);
    expect(analysis.sessions[0]?.source).toBe("claude-code");
    expect(analysis.sessions[0]?.sessionId).toBe("s-1");
    expect(analysis.sessions[0]?.completedTurns).toBe(1);
    expect(analysis.sessions[0]?.transcriptPath).toBe(
      join(home, ".claude", "projects", "-repo-app", "aaa.jsonl"),
    );
  });

  it("never descends into session subdirectories", async () => {
    const home = await createHome();
    await writeTranscript(
      home,
      "-repo-app",
      "aaa.jsonl",
      transcript("s-1", "/repo/app", "2026-08-20"),
    );
    await writeTranscript(
      home,
      join("-repo-app", "s-1", "subagents"),
      "agent-x.jsonl",
      transcript("s-1", "/repo/app", "2026-08-20"),
    );

    const analysis = await analyze(home);

    expect(analysis.scannedFiles).toBe(1);
    expect(analysis.sessions).toHaveLength(1);
  });

  it("prunes files last written before the window without opening them", async () => {
    const home = await createHome();
    const path = await writeTranscript(
      home,
      "-repo-app",
      "old.jsonl",
      transcript("s-old", "/repo/app", "2026-06-01"),
    );
    await utimes(path, new Date("2026-06-01T11:00:00.000Z"), new Date("2026-06-01T11:00:00.000Z"));

    const analysis = await analyze(home);

    expect(analysis.scannedFiles).toBe(0);
    expect(analysis.sessions).toHaveLength(0);
  });

  it("excludes a session that started before the window but was touched inside it", async () => {
    const home = await createHome();
    // Freshly written, so its mtime is now — only the record timestamps reveal its age.
    await writeTranscript(
      home,
      "-repo-app",
      "old.jsonl",
      transcript("s-old", "/repo/app", "2026-06-01"),
    );

    const analysis = await analyze(home);

    expect(analysis.scannedFiles).toBe(1);
    expect(analysis.sessions).toHaveLength(0);
    expect(analysis.unreadableFiles).toBe(0);
  });

  it("treats a missing projects root as an empty window", async () => {
    const home = await createHome();

    const analysis = await analyze(home);

    expect(analysis.scannedFiles).toBe(0);
    expect(analysis.sessions).toHaveLength(0);
    expect(analysis.repos).toHaveLength(0);
  });

  it("bounds and overlaps transcript metadata reads during discovery", async () => {
    const root = "/home/user/.claude/projects";
    const names = Array.from({ length: 30 }, (unused, index) => `session-${index}.jsonl`);
    const missing: PathContents = { exists: false, isDirectory: false };
    let activeInspections = 0;
    let peakInspections = 0;
    const reader: FileReader = {
      exists: () => Promise.resolve(false),
      inspect: async () => {
        activeInspections += 1;
        peakInspections = Math.max(peakInspections, activeInspections);
        try {
          await delay(5);
          return {
            exists: true,
            isDirectory: false,
            mtimeMs: new Date("2026-08-20T10:00:00.000Z").getTime(),
          };
        } finally {
          activeInspections -= 1;
        }
      },
      read: (path) => {
        if (path === root) {
          return Promise.resolve({ entries: ["-repo"], exists: true, isDirectory: true });
        }
        if (path === join(root, "-repo")) {
          return Promise.resolve({ entries: names, exists: true, isDirectory: true });
        }
        return Promise.resolve(missing);
      },
      readWithin: () => Promise.resolve({ contents: missing, kind: "unverified" }),
      realPath: () => Promise.resolve(undefined),
    };

    const files = await discoverClaudeSessions(reader, "/home/user", "2026-08-01");

    expect(files).toHaveLength(30);
    expect(peakInspections).toBeGreaterThan(1);
    expect(peakInspections).toBeLessThanOrEqual(24);
  });
});
