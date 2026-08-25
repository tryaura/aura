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
  const home = await mkdtemp(join(tmpdir(), "aura-cli-sessions-"));
  temporaryDirectories.push(home);
  return home;
}

interface RolloutOutcome {
  readonly command: string;
  readonly exitCode: number;
  readonly output?: string;
}

async function writeRollout(
  home: string,
  cwd: string,
  name = "rollout.jsonl",
  outcome: RolloutOutcome = { command: "npm test", exitCode: 127 },
): Promise<void> {
  const directory = join(home, ".codex", "sessions", "2026", "08", "24");
  await mkdir(directory, { recursive: true });
  const lines = [
    JSON.stringify({
      payload: {
        base_instructions: { text: "follow project rules" },
        cwd,
        git: {
          branch: "feature/session-health",
          commit_hash: "abc123",
          repository_url: "https://example.com/repo.git",
        },
        id: "s1",
      },
      timestamp: "2026-08-24T10:00:00.000Z",
      type: "session_meta",
    }),
    JSON.stringify({
      payload: { type: "task_started" },
      timestamp: "2026-08-24T10:00:01.000Z",
      type: "event_msg",
    }),
    JSON.stringify({
      payload: {
        arguments: JSON.stringify({ cmd: outcome.command }),
        call_id: "c1",
        name: "exec_command",
        type: "function_call",
      },
      timestamp: "2026-08-24T10:00:02.000Z",
      type: "response_item",
    }),
    JSON.stringify({
      payload: {
        call_id: "c1",
        output: `Process exited with code ${outcome.exitCode}\nOutput:\n${outcome.output ?? ""}`,
        type: "function_call_output",
      },
      timestamp: "2026-08-24T10:01:02.000Z",
      type: "response_item",
    }),
    // Kept after the failure so evidence line numbers in the brief stay stable.
    JSON.stringify({
      payload: {
        info: {
          total_token_usage: { cached_input_tokens: 900, input_tokens: 1000, output_tokens: 50 },
        },
        rate_limits: { plan_type: "pro", primary: { used_percent: 7, window_minutes: 10_080 } },
        type: "token_count",
      },
      timestamp: "2026-08-24T10:01:03.000Z",
      type: "event_msg",
    }),
  ];
  await writeFile(join(directory, name), `${lines.join("\n")}\n`);
}

function withClock(capture: ReturnType<typeof createCapture>): ReturnType<typeof createCapture> {
  return {
    ...capture,
    runtime: { ...capture.runtime, now: () => new Date("2026-08-25T12:00:00.000Z") },
  };
}

describe("sessions command", () => {
  it("leads with totals and flags the directory with failing tools", async () => {
    const home = await createHome();
    await writeRollout(home, join(home, "repo"));
    const capture = withClock(createCapture(["sessions", "--home", home]));

    const exitCode = await runCli(distro(), capture.runtime);

    expect(exitCode).toBe(0);
    expect(capture.stdout.text).toContain("Agent sessions — Codex, since 2026-07-26 (30 days)");
    expect(capture.stdout.text).toContain("Overall · F");
    expect(capture.stdout.text).toContain(
      "1 session in 1 project · 1m 3s wall · 1k tokens in, 50 out",
    );
    // The fixture session spends 60 of its 62 seconds inside its one failing tool call.
    expect(capture.stdout.text).toContain("in tools   ███████████████████░  F · 95% of wall time");
    expect(capture.stdout.text).toContain(
      "tool errs  ████████████████████  F · 100% of 1 tool call",
    );
    expect(capture.stdout.text).toContain("1k tokens in, 50 out");
    expect(capture.stdout.text).toContain(
      "cache hit  ██████████████████░░  A · 90% of input tokens reused",
    );
    expect(capture.stdout.text).toContain("Quota peaked at 7% of the pro plan's 7-day window");
    expect(capture.stdout.text).toContain("Needs attention");
    expect(capture.stdout.text).toContain("~/repo");
    expect(capture.stdout.text).toContain(
      "1 of 1 tool call had tool problems · outcomes: npm ×1 (invocation error)",
    );
    expect(capture.stdout.text).toContain(
      "npm not found (exit 127) — missing from this machine or misnamed in the instructions",
    );
    // One directory fits the busiest cap, so nothing is withheld and no pointer row appears.
    expect(capture.stdout.text).toContain("Projects by agent time");
    expect(capture.stdout.text).toContain("Grades: A great · B good · C fair · D poor · F failing");
    expect(capture.stdout.text).not.toContain("more project");
    expect(capture.stderr.text).toBe("");
  });

  it("caps the default list and names what --verbose would add", async () => {
    const home = await createHome();
    await Promise.all(
      Array.from({ length: 7 }, (unused, index) =>
        writeRollout(home, join(home, `repo-${index}`), `rollout-${index}.jsonl`),
      ),
    );
    const capture = withClock(createCapture(["sessions", "--home", home]));

    const exitCode = await runCli(distro(), capture.runtime);

    expect(exitCode).toBe(0);
    expect(capture.stdout.text).toContain("2 more projects in the window · --verbose lists");

    const verbose = withClock(createCapture(["sessions", "--home", home, "--verbose"]));
    await runCli(distro(), verbose.runtime);
    expect(verbose.stdout.text).toContain("All projects");
    expect(verbose.stdout.text).not.toContain("more project");
    for (let index = 0; index < 7; index += 1) {
      expect(verbose.stdout.text).toContain(`~/repo-${index}`);
    }
  });

  it("reports the empty window without failing", async () => {
    const home = await createHome();
    const capture = withClock(createCapture(["sessions", "--home", home]));

    const exitCode = await runCli(distro(), capture.runtime);

    expect(exitCode).toBe(0);
    expect(capture.stdout.text).toContain("No Codex sessions recorded since 2026-07-26");
  });

  it("does not flag a pending GitHub check as a tool problem", async () => {
    const home = await createHome();
    await writeRollout(home, join(home, "repo"), "rollout.jsonl", {
      command: "gh pr checks 42",
      exitCode: 8,
      output: "build\tpending\t0",
    });
    const briefPath = join(home, "pending-brief.md");
    const capture = withClock(createCapture(["sessions", "--home", home, `--brief=${briefPath}`]));

    const exitCode = await runCli(distro(), capture.runtime);

    expect(exitCode).toBe(0);
    expect(capture.stdout.text).not.toContain("Needs attention");
    expect(capture.stdout.text).toContain("0 check failures · 1 expected nonzero status");
    const brief = await readFile(briefPath, "utf8");
    expect(brief).toContain("0 operational · 0 check failures · 1 expected statuses · 0 unknown");
    expect(brief).toContain("No project crosses the materiality thresholds");
  });

  it("emits one machine-readable document with --json", async () => {
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

  it("writes a handoff brief with evidence pointers and prints the agent one-liner", async () => {
    const home = await createHome();
    await writeRollout(home, join(home, "repo"));
    const briefPath = join(home, "brief.md");
    const capture = withClock(createCapture(["sessions", "--home", home, `--brief=${briefPath}`]));

    const exitCode = await runCli(distro(), capture.runtime);

    expect(exitCode).toBe(0);
    expect(capture.stdout.text).toContain(`Brief written to ${briefPath}`);
    expect(capture.stdout.text).toContain(
      `Run: codex exec "Follow the instructions in ${briefPath}"`,
    );
    const brief = await readFile(briefPath, "utf8");
    expect(brief).toContain("# Coding-agent session health brief");
    expect(brief).toContain(`## Project: ${join(home, "repo")}`);
    expect(brief).toContain("[invocation_error, high confidence] `npm` ×1, exit 127");
    // The evidence names both the call and result lines; payloads stay on disk.
    expect(brief).toContain(
      `- evidence: call ${join(home, ".codex", "sessions", "2026", "08", "24", "rollout.jsonl")}:3 · result ${join(home, ".codex", "sessions", "2026", "08", "24", "rollout.jsonl")}:4`,
    );
    expect(brief).toContain("Classification coverage: 1/1 outcomes; 0 remain unknown");
    expect(brief).toContain("Evidence below samples 1 outcomes in 1 leading groups");
    expect(brief).toContain("commit abc123 · branch feature/session-health");
    expect(brief).toContain("initial prompt 20 chars at lines 1");
    expect(brief).toContain("A nonzero exit is not automatically a broken tool");
    expect(brief).toContain("## Output");
  });

  it("refuses --brief combined with --json", async () => {
    const capture = createCapture(["sessions", "--brief", "--json"]);

    const exitCode = await runCli(distro(), capture.runtime);

    expect(exitCode).toBe(2);
    expect(capture.stderr.text).toContain("--brief and --json contradict each other");
  });

  it("rejects an unusable --days value", async () => {
    const capture = createCapture(["sessions", "--days", "0"]);

    const exitCode = await runCli(distro(), capture.runtime);

    expect(exitCode).toBe(2);
    expect(capture.stderr.text).toContain("--days must be a whole number between 1 and 365");
  });

  it("renders the sessions help screen", async () => {
    const capture = createCapture(["sessions", "--help"]);

    const exitCode = await runCli(distro(), capture.runtime);

    expect(exitCode).toBe(0);
    expect(capture.stdout.text).toContain("sessions — Summarize recent coding agent sessions");
    expect(capture.stdout.text).toContain("Reads local transcripts only");
    expect(capture.stdout.text).not.toContain("--path");
  });
});
