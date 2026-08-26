import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../index.js";
import { createCapture, distro } from "../testing.js";
import { displayWidth } from "../text-width.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function createHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "aura-cli-sessions-layout-"));
  temporaryDirectories.push(home);
  return home;
}

function record(timestamp: string, type: string, payload: unknown): string {
  return JSON.stringify({ payload, timestamp, type });
}

async function writeRollout(home: string, withHealthData: boolean): Promise<void> {
  const directory = join(home, ".codex", "sessions", "2026", "08", "24");
  await mkdir(directory, { recursive: true });
  const lines = [
    record("2026-08-24T10:00:00.000Z", "session_meta", {
      cwd: join(home, "repo"),
      id: "layout",
    }),
    record("2026-08-24T10:00:01.000Z", "event_msg", { type: "task_started" }),
  ];
  if (withHealthData) {
    lines.push(
      record("2026-08-24T10:00:02.000Z", "response_item", {
        arguments: JSON.stringify({ cmd: "npm test" }),
        call_id: "c1",
        name: "exec_command",
        type: "function_call",
      }),
      record("2026-08-24T10:01:02.000Z", "response_item", {
        call_id: "c1",
        output: "Process exited with code 127\nOutput:\n",
        type: "function_call_output",
      }),
      record("2026-08-24T10:01:03.000Z", "event_msg", {
        info: {
          last_token_usage: {
            cached_input_tokens: 900,
            input_tokens: 950,
            output_tokens: 50,
            total_tokens: 1000,
          },
          model_context_window: 2000,
          total_token_usage: { cached_input_tokens: 900, input_tokens: 1000, output_tokens: 50 },
        },
        type: "token_count",
      }),
    );
  }
  lines.push(
    record("2026-08-24T10:01:03.000Z", "event_msg", {
      duration_ms: withHealthData ? 62_000 : 1_000,
      type: "task_complete",
    }),
  );
  await writeFile(join(directory, "rollout.jsonl"), `${lines.join("\n")}\n`);
}

function captureFor(home: string): ReturnType<typeof createCapture> {
  const capture = createCapture(["sessions", "--home", home]);
  return {
    ...capture,
    runtime: { ...capture.runtime, now: () => new Date("2026-08-25T12:00:00.000Z") },
  };
}

describe("sessions report layout", () => {
  it("reflows cards at 40 columns without overflowing the report", async () => {
    const home = await createHome();
    await writeRollout(home, true);
    const capture = captureFor(home);
    Object.assign(capture.stdout, { columns: 40 });

    expect(await runCli(distro(), capture.runtime)).toBe(0);
    expect(capture.stdout.text).toContain(
      "  ┌ Tool errors ───┐ ┌ Context ───────┐\n" + "  │F · 100%        │ │B · 50% peak    │",
    );
    expect(capture.stdout.text).toContain(
      "  ┌ Compactions ───┐ ┌ Validation ────┐\n" + "  │A · 0.00/session│ │1 / 1 failed    │",
    );
    for (const line of capture.stdout.text.trimEnd().split("\n")) {
      expect(displayWidth(line)).toBeLessThanOrEqual(40);
    }
  });

  it("keeps unavailable health signals in stable card positions", async () => {
    const home = await createHome();
    await writeRollout(home, false);
    const capture = captureFor(home);

    expect(await runCli(distro(), capture.runtime)).toBe(0);
    expect(capture.stdout.text).toContain(
      "│No tool calls   │ │Not recorded    │ │A · 0.00/session│ │No validation   │",
    );
    expect(capture.stdout.text).toContain(
      "│                │ │                │ │0 total         │ │runs recorded   │",
    );
  });
});
