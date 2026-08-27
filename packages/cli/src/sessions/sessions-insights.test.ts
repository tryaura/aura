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

function record(timestamp: string, type: string, payload: unknown): string {
  return JSON.stringify({ payload, timestamp, type });
}

function execCall(at: string, callId: string, cmd: string): string {
  return record(at, "response_item", {
    arguments: JSON.stringify({ cmd }),
    call_id: callId,
    name: "exec_command",
    type: "function_call",
  });
}

function execOutput(at: string, callId: string, exitCode: number): string {
  return record(at, "response_item", {
    call_id: callId,
    output: `Process exited with code ${exitCode}\nOutput:\n`,
    type: "function_call_output",
  });
}

/** One session that validates twice, edits nothing, and completes: every insight row fires. */
async function writeRollout(home: string): Promise<void> {
  const directory = join(home, ".codex", "sessions", "2026", "08", "24");
  await mkdir(directory, { recursive: true });
  const lines = [
    record("2026-08-24T10:00:00.000Z", "session_meta", {
      cwd: join(home, "repo"),
      git: { branch: "aura/AURA-7-metrics" },
      id: "s1",
    }),
    record("2026-08-24T10:00:01.000Z", "event_msg", { type: "task_started" }),
    execCall("2026-08-24T10:00:02.000Z", "c1", "pnpm test"),
    execOutput("2026-08-24T10:00:12.000Z", "c1", 1),
    record("2026-08-24T10:00:13.000Z", "event_msg", {
      info: {
        last_token_usage: {
          cached_input_tokens: 0,
          input_tokens: 5000,
          output_tokens: 200,
          total_tokens: 5200,
        },
        model_context_window: 10_000,
        total_token_usage: { cached_input_tokens: 0, input_tokens: 5000, output_tokens: 200 },
      },
      type: "token_count",
    }),
    execCall("2026-08-24T10:00:14.000Z", "c2", "pnpm test"),
    execOutput("2026-08-24T10:00:44.000Z", "c2", 0),
    execCall("2026-08-24T10:00:45.000Z", "c3", "git diff"),
    execOutput("2026-08-24T10:00:50.000Z", "c3", 0),
    record("2026-08-24T10:00:51.000Z", "event_msg", {
      duration_ms: 50_000,
      type: "task_complete",
    }),
  ];
  await writeFile(join(directory, "rollout.jsonl"), `${lines.join("\n")}\n`);
}

describe("sessions insight sections", () => {
  it("answers validation, first green, initial context, endings, commands, and work items", async () => {
    const home = await mkdtemp(join(tmpdir(), "aura-cli-sessions-insights-"));
    temporaryDirectories.push(home);
    await writeRollout(home);
    const capture = createCapture(["sessions", "--home", home]);
    const runtime = { ...capture.runtime, now: () => new Date("2026-08-25T12:00:00.000Z") };

    const exitCode = await runCli(distro(), runtime);

    expect(exitCode).toBe(0);
    expect(capture.stdout.text).toContain("│1 / 2 failed    │");
    expect(capture.stdout.text).toContain("│40s spent       │");
    expect(capture.stdout.text).toContain("First green       2 runs · 5.2k tokens · medians");
    expect(capture.stdout.text).toContain("Initial context   5k tokens · median session");
    expect(capture.stdout.text).toContain("Inferred endings  1 autonomous");
    expect(capture.stdout.text).toContain("Commands by tool time");
    expect(capture.stdout.text).toContain(
      "pnpm test         ████████████████████  40s\n      2 calls · 50% failed",
    );
    expect(capture.stdout.text).toContain(
      "git diff          ██▌░░░░░░░░░░░░░░░░░  5s\n      1 call",
    );
    expect(capture.stdout.text).toContain(
      "Work items · keys seen in prompts, branches, and git/gh commands",
    );
    expect(capture.stdout.text).toContain(
      "Sessions per issue key · p50 1 · p90 1 · 1 issue key observed",
    );
    expect(capture.stdout.text).not.toContain("AURA-7            51s agent time");
    expect(capture.stderr.text).toBe("");
  });
});
