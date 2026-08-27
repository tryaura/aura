import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  const home = await mkdtemp(join(tmpdir(), "aura-cli-sessions-json-"));
  temporaryDirectories.push(home);
  return home;
}

async function writeRollout(home: string, cwd: string): Promise<void> {
  const directory = join(home, ".codex", "sessions", "2026", "08", "24");
  await mkdir(directory, { recursive: true });
  const lines = [
    { payload: { cwd, id: "s1" }, timestamp: "2026-08-24T10:00:00.000Z", type: "session_meta" },
    {
      payload: { type: "task_started" },
      timestamp: "2026-08-24T10:00:01.000Z",
      type: "event_msg",
    },
    {
      payload: {
        arguments: JSON.stringify({ cmd: "npm test" }),
        call_id: "c1",
        name: "exec_command",
        type: "function_call",
      },
      timestamp: "2026-08-24T10:00:02.000Z",
      type: "response_item",
    },
    {
      payload: {
        call_id: "c1",
        output: "Process exited with code 127\nOutput:\n",
        type: "function_call_output",
      },
      timestamp: "2026-08-24T10:01:02.000Z",
      type: "response_item",
    },
  ].map((record) => JSON.stringify(record));
  await writeFile(join(directory, "rollout.jsonl"), `${lines.join("\n")}\n`);
}

function withClock(capture: ReturnType<typeof createCapture>): ReturnType<typeof createCapture> {
  return {
    ...capture,
    runtime: { ...capture.runtime, now: () => new Date("2026-08-25T12:00:00.000Z") },
  };
}

describe("sessions --json", () => {
  it("emits one machine-readable document", async () => {
    const home = await createHome();
    await writeRollout(home, join(home, "repo"));
    const capture = withClock(createCapture(["sessions", "--home", home, "--json"]));

    const exitCode = await runCli(distro(), capture.runtime);

    expect(exitCode).toBe(0);
    const parsed: unknown = JSON.parse(capture.stdout.text);
    expect(parsed).toMatchObject({
      days: 30,
      scannedFiles: 1,
      since: "2026-07-26",
      source: "codex",
      unreadableFiles: 0,
    });
    expect(capture.stdout.text.trim().split("\n")).toHaveLength(1);
  });

  it("carries turn and command detail, and per-call rows only with --detailed", async () => {
    const home = await createHome();
    await writeRollout(home, join(home, "repo"));
    const summary = withClock(createCapture(["sessions", "--home", home, "--json"]));
    await runCli(distro(), summary.runtime);
    const summaryDocument = JSON.parse(summary.stdout.text) as {
      sessions: readonly Record<string, unknown>[];
    };
    expect(summaryDocument.sessions[0]).toMatchObject({
      commands: [{ command: "npm", subcommand: "test", tool: "shell" }],
      turnDetails: [{ closed: "log-end", index: 0, toolCalls: 1 }],
    });
    expect(summaryDocument.sessions[0]).not.toHaveProperty("calls");

    const detailed = withClock(createCapture(["sessions", "--home", home, "--json", "--detailed"]));
    await runCli(distro(), detailed.runtime);
    const document = JSON.parse(detailed.stdout.text) as {
      sessions: readonly Record<string, unknown>[];
    };
    expect(document.sessions[0]).toMatchObject({
      calls: [
        {
          callId: "c1",
          command: "npm",
          exitCode: 127,
          status: "failure",
          subcommand: "test",
          tool: "shell",
          turnIndex: 0,
        },
      ],
    });
  });

  it("refuses --detailed without --json", async () => {
    const capture = createCapture(["sessions", "--detailed"]);

    expect(await runCli(distro(), capture.runtime)).toBe(2);
    expect(capture.stderr.text).toContain("--detailed requires --json");
  });
});
