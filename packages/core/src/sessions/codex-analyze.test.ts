import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFileReader, type FileReader } from "../workspace/reader.js";
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
  const home = await mkdtemp(join(tmpdir(), "aura-sessions-"));
  temporaryDirectories.push(home);
  return home;
}

async function writeRollout(
  home: string,
  day: readonly [string, string, string],
  name: string,
  lines: readonly string[],
): Promise<void> {
  const directory = join(home, ".codex", "sessions", ...day);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name), `${lines.join("\n")}\n`);
}

function rollout(id: string, cwd: string, day: string): readonly string[] {
  return [
    JSON.stringify({
      payload: { cwd, id },
      timestamp: `${day}T10:00:00.000Z`,
      type: "session_meta",
    }),
    JSON.stringify({
      payload: { type: "task_started" },
      timestamp: `${day}T10:00:01.000Z`,
      type: "event_msg",
    }),
    JSON.stringify({
      payload: {
        arguments: JSON.stringify({ cmd: "npm test" }),
        call_id: "c1",
        name: "exec_command",
        type: "function_call",
      },
      timestamp: `${day}T10:00:02.000Z`,
      type: "response_item",
    }),
    JSON.stringify({
      payload: {
        call_id: "c1",
        output: "Process exited with code 1",
        type: "function_call_output",
      },
      timestamp: `${day}T10:00:03.000Z`,
      type: "response_item",
    }),
  ];
}

describe("analyzeCodexSessions", () => {
  it("scans only the window, groups by cwd, and counts unreadable files", async () => {
    const home = await createHome();
    await writeRollout(
      home,
      ["2026", "08", "20"],
      "a.jsonl",
      rollout("s1", "/repo/one", "2026-08-20"),
    );
    await writeRollout(
      home,
      ["2026", "08", "21"],
      "b.jsonl",
      rollout("s2", "/repo/one", "2026-08-21"),
    );
    await writeRollout(
      home,
      ["2026", "08", "21"],
      "c.jsonl",
      rollout("s3", "/repo/two", "2026-08-21"),
    );
    await writeRollout(home, ["2026", "08", "21"], "junk.jsonl", ["not a codex file"]);
    // Outside the seven-day window: pruned by directory date, never opened.
    await writeRollout(
      home,
      ["2026", "07", "01"],
      "old.jsonl",
      rollout("s0", "/repo/one", "2026-07-01"),
    );

    const analysis = await analyzeCodexSessions({
      days: 7,
      homeDir: home,
      now: new Date("2026-08-25T12:00:00.000Z"),
      reader: createFileReader(),
    });

    expect(analysis.since).toBe("2026-08-18");
    expect(analysis.scannedFiles).toBe(4);
    expect(analysis.unreadableFiles).toBe(1);
    expect(analysis.sessions).toHaveLength(3);
    // Neither directory exists on disk, so each stays its own path-labelled project.
    expect(analysis.repos.map((repo) => [repo.project, repo.sessions])).toEqual([
      ["/repo/one", 2],
      ["/repo/two", 1],
    ]);
    const one = analysis.repos[0];
    expect(one?.directories).toBe(1);
    expect(one?.toolCalls).toBe(2);
    expect(one?.failedToolCalls).toBe(2);
    expect(one).toMatchObject({
      checkFailures: 0,
      expectedStatuses: 0,
      operationalFailures: 0,
      outcomeGroupCount: 1,
      unknownOutcomes: 2,
    });
    expect(one?.outcomeCounts).toMatchObject([
      {
        confidence: "low",
        count: 2,
        exitCode: 1,
        kind: "unknown_nonzero",
        label: "npm",
      },
    ]);
    expect(one?.outcomeCounts[0]?.exemplars).toMatchObject([
      {
        callLine: 3,
        file: join(home, ".codex", "sessions", "2026", "08", "20", "a.jsonl"),
        resultLine: 4,
        sessionId: "s1",
      },
      {
        callLine: 3,
        file: join(home, ".codex", "sessions", "2026", "08", "21", "b.jsonl"),
        resultLine: 4,
        sessionId: "s2",
      },
    ]);
    expect(one?.hotspots).toEqual([
      { compactions: 0, cwd: "/repo/one", failedToolCalls: 2, sessions: 2 },
    ]);
    expect(one?.wallClockMs).toBe(6000);
  });

  it("collapses workspace-shaped worktrees of one project into one row", async () => {
    const home = await createHome();
    const first = join(home, "hub", "workspaces", "family-planner", "milan-v1");
    const second = join(home, "hub", "workspaces", "family-planner", "oslo");
    await writeRollout(home, ["2026", "08", "21"], "a.jsonl", rollout("s1", first, "2026-08-21"));
    await writeRollout(home, ["2026", "08", "22"], "b.jsonl", rollout("s2", second, "2026-08-22"));

    const analysis = await analyzeCodexSessions({
      days: 7,
      homeDir: home,
      now: new Date("2026-08-25T12:00:00.000Z"),
      reader: createFileReader(),
    });

    expect(analysis.repos).toHaveLength(1);
    expect(analysis.repos[0]?.project).toBe("family-planner");
    expect(analysis.repos[0]?.directories).toBe(2);
    expect(analysis.repos[0]?.sessions).toBe(2);
  });

  it("names a live checkout after its origin remote", async () => {
    const home = await createHome();
    const checkout = join(home, "clones", "tashkent");
    await mkdir(join(checkout, ".git"), { recursive: true });
    await writeFile(
      join(checkout, ".git", "config"),
      '[remote "origin"]\n\turl = git@github.com:someone/family_planner.git\n',
    );
    await writeRollout(
      home,
      ["2026", "08", "21"],
      "a.jsonl",
      rollout("s1", checkout, "2026-08-21"),
    );

    const analysis = await analyzeCodexSessions({
      days: 7,
      homeDir: home,
      now: new Date("2026-08-25T12:00:00.000Z"),
      reader: createFileReader(),
    });

    expect(analysis.repos[0]?.project).toBe("family_planner");
  });

  it("follows a linked worktree's .git file to the main checkout's origin", async () => {
    const home = await createHome();
    const main = join(home, "clones", "main-checkout");
    await mkdir(join(main, ".git", "worktrees", "feature"), { recursive: true });
    await writeFile(
      join(main, ".git", "config"),
      '[remote "origin"]\n\turl = https://github.com/someone/tashkent.git\n',
    );
    const worktree = join(home, "trees", "feature");
    await mkdir(worktree, { recursive: true });
    await writeFile(
      join(worktree, ".git"),
      `gitdir: ${join(main, ".git", "worktrees", "feature")}\n`,
    );
    await writeRollout(
      home,
      ["2026", "08", "21"],
      "a.jsonl",
      rollout("s1", worktree, "2026-08-21"),
    );
    await writeRollout(home, ["2026", "08", "22"], "b.jsonl", rollout("s2", main, "2026-08-22"));

    const analysis = await analyzeCodexSessions({
      days: 7,
      homeDir: home,
      now: new Date("2026-08-25T12:00:00.000Z"),
      reader: createFileReader(),
    });

    expect(analysis.repos).toHaveLength(1);
    expect(analysis.repos[0]?.project).toBe("tashkent");
    expect(analysis.repos[0]?.directories).toBe(2);
  });

  it("reports an empty analysis when the codex directory does not exist", async () => {
    const home = await createHome();

    const analysis = await analyzeCodexSessions({
      days: 7,
      homeDir: home,
      now: new Date("2026-08-25T12:00:00.000Z"),
      reader: createFileReader(),
    });

    expect(analysis.scannedFiles).toBe(0);
    expect(analysis.sessions).toEqual([]);
    expect(analysis.repos).toEqual([]);
  });

  it("bounds concurrent transcript reads", async () => {
    const home = await createHome();
    await Promise.all(
      Array.from({ length: 8 }, (unused, index) =>
        writeRollout(
          home,
          ["2026", "08", "21"],
          `${index}.jsonl`,
          rollout(`s${index}`, `/repo/${index}`, "2026-08-21"),
        ),
      ),
    );
    const base = createFileReader();
    let active = 0;
    let peak = 0;
    const reader: FileReader = {
      ...base,
      read: async (path, options) => {
        if (!path.endsWith(".jsonl")) {
          return base.read(path, options);
        }
        active += 1;
        peak = Math.max(peak, active);
        try {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          return await base.read(path, options);
        } finally {
          active -= 1;
        }
      },
    };

    const analysis = await analyzeCodexSessions({
      days: 7,
      homeDir: home,
      now: new Date("2026-08-25T12:00:00.000Z"),
      reader,
    });

    expect(analysis.sessions).toHaveLength(8);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
  });
});
