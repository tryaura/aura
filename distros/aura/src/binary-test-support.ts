import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const BINARY_PATH = fileURLToPath(new URL("../dist/aura", import.meta.url));

/** Just enough of a built seed to run the binary inside it. */
export interface SeedPaths {
  readonly homeDir: string;
  readonly pathDir: string;
  readonly workspaceDir: string;
}

export interface BinaryRun {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

/** Runs the compiled distribution and preserves supported non-zero Aura exits for assertions. */
export async function runCompiled(
  seed: SeedPaths,
  args: readonly string[],
  environmentVariables: Readonly<Record<string, string>> = {},
): Promise<BinaryRun> {
  try {
    const result = await execFileAsync(BINARY_PATH, args, {
      cwd: seed.workspaceDir,
      encoding: "utf8",
      env: {
        AURA_TELEMETRY: "off",
        HOME: seed.homeDir,
        PATH: seed.pathDir,
        ...environmentVariables,
      },
    });
    return { exitCode: 0, stderr: result.stderr, stdout: result.stdout };
  } catch (error) {
    return failedRun(error);
  }
}

/** `execFile` rejects a non-zero exit with the completed run's output attached to the error. */
function failedRun(error: unknown): BinaryRun {
  const run: Readonly<Record<string, unknown>> = error instanceof Error ? { ...error } : {};
  return {
    exitCode: typeof run["code"] === "number" ? run["code"] : 1,
    stderr: outputText(run["stderr"]),
    stdout: outputText(run["stdout"]),
  };
}

function outputText(value: unknown): string {
  return typeof value === "string" ? value : "";
}
