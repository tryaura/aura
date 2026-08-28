import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFileReader } from "../workspace/reader.js";
import { analyzeAgentSessions } from "./analyze.js";
import type { SessionSource } from "./session-detail-metrics.js";
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

async function writeCodexRollout(home: string): Promise<void> {
  const directory = join(home, ".codex", "sessions", "2026", "08", "20");
  await mkdir(directory, { recursive: true });
  const meta = JSON.stringify({
    payload: { cwd: "/repo/app", id: "codex-1" },
    timestamp: "2026-08-20T09:00:00.000Z",
    type: "session_meta",
  });
  await writeFile(join(directory, "rollout.jsonl"), `${meta}\n`);
}

async function writeClaudeTranscript(home: string): Promise<void> {
  const directory = join(home, ".claude", "projects", "-repo-app");
  await mkdir(directory, { recursive: true });
  const prompt = JSON.stringify({
    cwd: "/repo/app",
    isSidechain: false,
    message: { content: "do the work", role: "user" },
    promptSource: "typed",
    sessionId: "claude-1",
    timestamp: "2026-08-20T10:00:00.000Z",
    type: "user",
    uuid: "uuid-1",
  });
  await writeFile(join(directory, "session.jsonl"), `${prompt}\n`);
}

function analyze(home: string, sources?: readonly SessionSource[]): Promise<SessionAnalysis> {
  return analyzeAgentSessions({
    days: 30,
    homeDir: home,
    now: new Date("2026-08-21T12:00:00.000Z"),
    reader: createFileReader(),
    ...(sources === undefined ? {} : { sources }),
  });
}

describe("analyzeAgentSessions", () => {
  it("merges both sources into one analysis by default", async () => {
    const home = await createHome();
    await writeCodexRollout(home);
    await writeClaudeTranscript(home);

    const analysis = await analyze(home);

    expect(analysis.sources).toEqual(["claude-code", "codex"]);
    expect(analysis.scannedFiles).toBe(2);
    expect(analysis.sessions.map((session) => session.source).sort()).toEqual([
      "claude-code",
      "codex",
    ]);
  });

  it("names every scanned source even when one has no transcripts", async () => {
    const home = await createHome();
    await writeCodexRollout(home);

    const analysis = await analyze(home);

    expect(analysis.sources).toEqual(["claude-code", "codex"]);
    expect(analysis.sessions.map((session) => session.source)).toEqual(["codex"]);
  });

  it("narrows to the requested source", async () => {
    const home = await createHome();
    await writeCodexRollout(home);
    await writeClaudeTranscript(home);

    const codexOnly = await analyze(home, ["codex"]);
    expect(codexOnly.sources).toEqual(["codex"]);
    expect(codexOnly.sessions.map((session) => session.source)).toEqual(["codex"]);

    const claudeOnly = await analyze(home, ["claude-code"]);
    expect(claudeOnly.sources).toEqual(["claude-code"]);
    expect(claudeOnly.sessions.map((session) => session.source)).toEqual(["claude-code"]);
  });

  it("sorts and deduplicates the requested sources", async () => {
    const home = await createHome();

    const analysis = await analyze(home, ["codex", "claude-code", "codex"]);

    expect(analysis.sources).toEqual(["claude-code", "codex"]);
  });
});
