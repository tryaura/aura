import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../index.js";
import { createCapture, distro } from "../testing.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function createHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "aura-cli-sessions-src-"));
  temporaryDirectories.push(home);
  return home;
}

async function writeCodexRollout(home: string, cwd: string): Promise<void> {
  const directory = join(home, ".codex", "sessions", "2026", "08", "24");
  await mkdir(directory, { recursive: true });
  const meta = JSON.stringify({
    payload: { cwd, id: "codex-1" },
    timestamp: "2026-08-24T10:00:00.000Z",
    type: "session_meta",
  });
  await writeFile(join(directory, "rollout.jsonl"), `${meta}\n`);
}

async function writeClaudeTranscript(home: string, cwd: string): Promise<void> {
  const directory = join(home, ".claude", "projects", "-repo");
  await mkdir(directory, { recursive: true });
  const lines = [
    JSON.stringify({
      cwd,
      isSidechain: false,
      message: { content: "do the work", role: "user" },
      promptSource: "typed",
      sessionId: "claude-1",
      timestamp: "2026-08-24T11:00:00.000Z",
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
      sessionId: "claude-1",
      timestamp: "2026-08-24T11:00:30.000Z",
      type: "assistant",
      uuid: "uuid-2",
    }),
  ];
  await writeFile(join(directory, "claude-1.jsonl"), `${lines.join("\n")}\n`);
}

function withClock(capture: ReturnType<typeof createCapture>): ReturnType<typeof createCapture> {
  return {
    ...capture,
    runtime: { ...capture.runtime, now: () => new Date("2026-08-25T12:00:00.000Z") },
  };
}

describe("sessions --source", () => {
  it("reads Claude Code transcripts into the merged default report and JSON", async () => {
    const home = await createHome();
    await writeCodexRollout(home, join(home, "repo"));
    await writeClaudeTranscript(home, join(home, "repo"));
    const capture = withClock(createCapture(["sessions", "--json", "--home", home]));

    const exitCode = await runCli(distro(), capture.runtime);

    expect(exitCode).toBe(0);
    const document: unknown = JSON.parse(capture.stdout.text);
    // `source` predates multi-source analysis and stays frozen; `sources` is authoritative.
    expect(document).toMatchObject({
      sessions: [
        { sessionId: "claude-1", source: "claude-code" },
        { sessionId: "codex-1", source: "codex" },
      ],
      source: "codex",
      sources: ["claude-code", "codex"],
    });
  });

  it("narrows to Claude Code, accepting the claude alias", async () => {
    const home = await createHome();
    await writeCodexRollout(home, join(home, "repo"));
    await writeClaudeTranscript(home, join(home, "repo"));
    const capture = withClock(
      createCapture(["sessions", "--json", "--source", "claude", "--home", home]),
    );

    const exitCode = await runCli(distro(), capture.runtime);

    expect(exitCode).toBe(0);
    const document: unknown = JSON.parse(capture.stdout.text);
    expect(document).toMatchObject({
      sessions: [{ source: "claude-code" }],
      source: "claude-code",
      sources: ["claude-code"],
    });
  });

  it("labels the human report with the narrowed source", async () => {
    const home = await createHome();
    await writeClaudeTranscript(home, join(home, "repo"));
    const capture = withClock(
      createCapture(["sessions", "--source", "claude-code", "--home", home]),
    );

    const exitCode = await runCli(distro(), capture.runtime);

    expect(exitCode).toBe(0);
    expect(capture.stdout.text).toContain(
      "Agent sessions — Claude Code, since 2026-07-26 (30 days)",
    );
  });

  it("rejects an unknown source selector", async () => {
    const home = await createHome();
    const capture = withClock(createCapture(["sessions", "--source", "cursor", "--home", home]));

    const exitCode = await runCli(distro(), capture.runtime);

    expect(exitCode).toBe(2);
    expect(capture.stderr.text).toContain("--source must be codex or claude-code.");
  });

  it("prints the claude runner for a Claude-only brief", async () => {
    const home = await createHome();
    await writeClaudeTranscript(home, join(home, "repo"));
    const briefPath = join(home, "claude-brief.md");
    const capture = withClock(
      createCapture([
        "sessions",
        "--source",
        "claude-code",
        `--brief=${briefPath}`,
        "--home",
        home,
      ]),
    );

    const exitCode = await runCli(distro(), capture.runtime);

    expect(exitCode).toBe(0);
    expect(capture.stdout.text).toContain(`Run: claude 'Follow the instructions in ${briefPath}'`);
    const brief = await readFile(briefPath, "utf8");
    expect(brief).toContain("It covers Claude Code");
    expect(brief).toContain("Claude Code records: call via");
    expect(brief).not.toContain("Codex records: call via");
  });
});
