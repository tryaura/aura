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

  it("rejects unsupported process exit codes", async () => {
    await using seed = await createSeedBuilder().build();
    const binaryPath = await writeFixtureBinary(
      seed.workspaceDir,
      `#!/bin/sh\nprintf '%s\\n' '${EMPTY_REPORT}'\nexit 7\n`,
    );

    await expect(runBinaryCheck({ binaryPath, seed })).rejects.toThrow("unsupported exit code 7");
  });

  it("rejects signal termination", async () => {
    await using seed = await createSeedBuilder().build();
    const binaryPath = await writeFixtureBinary(seed.workspaceDir, "#!/bin/sh\nkill -TERM $$\n");

    await expect(runBinaryCheck({ binaryPath, seed })).rejects.toThrow(
      "terminated from signal SIGTERM",
    );
  });

  it("kills a run that outlives its timeout and keeps what it printed", async () => {
    await using seed = await createSeedBuilder().build();
    const binaryPath = await writeFixtureBinary(
      seed.workspaceDir,
      "#!/bin/sh\nprintf 'started\\n' >&2\nwhile : ; do : ; done\n",
    );

    // Long enough that the fixture has certainly reached its loop even on a loaded machine, which is
    // what makes "the transcript survived the kill" the thing this asserts rather than a race.
    const run = runBinaryCheck({ binaryPath, seed, timeoutMs: 1_500 });

    await expect(run).rejects.toThrow("killed the run after 1500ms without an exit");
    await expect(run).rejects.toThrow("started");
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
