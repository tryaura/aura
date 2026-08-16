import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createSeedBuilder, runBinaryCheck } from "./index.js";

const EMPTY_REPORT = JSON.stringify({
  diagnostics: [],
  exitCode: 2,
  findings: [],
  passedChecks: [],
  skipped: [],
  status: "empty",
  summary: { errors: 0, informational: 0, passed: 0, warnings: 0 },
});

describe("runBinaryCheck", () => {
  it("runs the binary inside the seed and returns a normalized result", async () => {
    await using seed = await createSeedBuilder().build();
    const binaryPath = await writeFixtureBinary(
      seed.workspaceDir,
      [
        "#!/bin/sh",
        '[ "$1" = "check" ] && [ "$2" = "--json" ] || exit 7',
        '[ "$3" = "--home" ] && [ "$4" = "$HOME" ] || exit 7',
        '[ "$5" = "--path" ] && [ "$6" = "$PATH" ] || exit 7',
        'printf "changed\\n" > "$HOME/state.txt"',
        'printf "%s\\n" "$HOME" >&2',
        `printf '%s\\n' '${EMPTY_REPORT}'`,
        "exit 2",
      ].join("\n"),
    );

    const result = await runBinaryCheck({ binaryPath, seed });

    expect(result.exitCode).toBe(2);
    expect(result.report.status).toBe("empty");
    expect(result.stderr).toBe("<HOME>\n");
    expect(result.diffs).toMatchObject([{ path: "<HOME>/state.txt", status: "added" }]);
  });

  it("includes the transcript when stdout is not a report", async () => {
    await using seed = await createSeedBuilder().build();
    const binaryPath = await writeFixtureBinary(
      seed.workspaceDir,
      "#!/bin/sh\nprintf 'not json\\n'\nprintf 'details\\n' >&2\nexit 2\n",
    );

    const run = runBinaryCheck({ binaryPath, seed });

    await expect(run).rejects.toThrow("Check runner expected one JSON report on stdout.");
    await expect(run).rejects.toThrow("details");
  });

  it("rejects a missing executable", async () => {
    await using seed = await createSeedBuilder().build();

    await expect(
      runBinaryCheck({ binaryPath: join(seed.workspaceDir, "missing-aura"), seed }),
    ).rejects.toThrow("Could not launch compiled Aura binary");
  });

  it("rejects unsupported process exit codes and keeps what the run printed", async () => {
    await using seed = await createSeedBuilder().build();
    const binaryPath = await writeFixtureBinary(
      seed.workspaceDir,
      `#!/bin/sh\nprintf 'diagnostic detail\\n' >&2\nprintf '%s\\n' '${EMPTY_REPORT}'\nexit 7\n`,
    );

    // The transcript is what turns a rejected run into a debuggable one, and every rejection
    // builds it the same way — so a run that exits on its own proves it without a race.
    const run = runBinaryCheck({ binaryPath, seed });
    await expect(run).rejects.toThrow("unsupported exit code 7");
    await expect(run).rejects.toThrow("diagnostic detail");
  });

  it("rejects signal termination", async () => {
    await using seed = await createSeedBuilder().build();
    const binaryPath = await writeFixtureBinary(seed.workspaceDir, "#!/bin/sh\nkill -TERM $$\n");

    await expect(runBinaryCheck({ binaryPath, seed })).rejects.toThrow(
      "terminated from signal SIGTERM",
    );
  });

  it("kills a run that outlives its timeout", async () => {
    await using seed = await createSeedBuilder().build();
    // `exec sleep` rather than a busy loop: the process only has to outlive the timeout, and a
    // spinning shell competes for the core this process needs to fire the timer. `exec` also puts
    // `sleep` in the process the runner kills, so nothing survives the SIGKILL.
    //
    // Deliberately asserts nothing about the transcript. Whether a killed child's buffered output
    // reaches the parent depends on how promptly it was scheduled before the kill, which on a
    // loaded machine it is not — and the transcript is proven on the exit-code path above, which
    // builds it through the same code and does not race.
    const binaryPath = await writeFixtureBinary(seed.workspaceDir, "#!/bin/sh\nexec sleep 30\n");

    await expect(runBinaryCheck({ binaryPath, seed, timeoutMs: 1_500 })).rejects.toThrow(
      "killed the run after 1500ms without an exit",
    );
  });

  it("rejects arguments the runner already supplies", async () => {
    await using seed = await createSeedBuilder().build();
    const binaryPath = join(seed.workspaceDir, "unused-aura");

    await expect(runBinaryCheck({ args: ["--home=/elsewhere"], binaryPath, seed })).rejects.toThrow(
      "Check runner already supplies --home",
    );
    await expect(runBinaryCheck({ args: ["--json"], binaryPath, seed })).rejects.toThrow(
      "Check runner already supplies --json",
    );
  });
});

async function writeFixtureBinary(workspaceDir: string, source: string): Promise<string> {
  const binaryPath = join(workspaceDir, "fixture-aura");
  await writeFile(binaryPath, source, "utf8");
  await chmod(binaryPath, 0o755);
  return binaryPath;
}
