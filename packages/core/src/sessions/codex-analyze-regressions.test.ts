import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFileReader } from "../workspace/reader.js";
import { analyzeCodexSessions } from "./codex-analyze.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function createHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "aura-session-regressions-"));
  temporaryDirectories.push(home);
  return home;
}

async function writeSession(
  home: string,
  name: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<void> {
  const directory = join(home, ".codex", "sessions", "2026", "08", "21");
  await mkdir(directory, { recursive: true });
  const record = JSON.stringify({
    payload,
    timestamp: "2026-08-21T10:00:00.000Z",
    type: "session_meta",
  });
  await writeFile(join(directory, name), `${record}\n`);
}

async function analyze(home: string) {
  return analyzeCodexSessions({
    days: 7,
    homeDir: home,
    now: new Date("2026-08-25T12:00:00.000Z"),
    reader: createFileReader(),
  });
}

describe("session analysis regressions", () => {
  it("excludes internal approval-review sessions", async () => {
    const home = await createHome();
    await writeSession(home, "coding.jsonl", { cwd: "/repo", id: "coding" });
    await writeSession(home, "guardian.jsonl", {
      cwd: "/repo",
      id: "guardian",
      parent_thread_id: "parent",
      source: { subagent: { other: "guardian" } },
      thread_source: "subagent",
    });

    const analysis = await analyze(home);

    expect(analysis.scannedFiles).toBe(2);
    expect(analysis.unreadableFiles).toBe(0);
    expect(analysis.sessions.map((session) => session.sessionId)).toEqual(["coding"]);
  });

  it("groups deleted worktrees by their recorded Git repository", async () => {
    const home = await createHome();
    const git = { repository_url: "git@github.com:someone/family_planner.git" };
    await writeSession(home, "a.jsonl", { cwd: "/deleted/worktree-a", git, id: "s1" });
    await writeSession(home, "b.jsonl", { cwd: "/deleted/worktree-b", git, id: "s2" });

    const analysis = await analyze(home);

    expect(analysis.repos).toHaveLength(1);
    expect(analysis.repos[0]?.project).toBe("family_planner");
    expect(analysis.repos[0]?.directories).toBe(2);
  });
});
