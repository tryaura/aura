import type { EnvironmentPlatform } from "@tryaura/aura-sdk";

/** Matches Windows shell scripts, which only `cmd.exe` can run. */
const WINDOWS_SCRIPT_PATTERN = /\.(?:bat|cmd)$/iu;

/** Characters `cmd.exe` interprets, caret-escaped before a line reaches it. */
const CMD_METACHARACTER_PATTERN = /([()\][%!^"`<>&|;, *?])/gu;

/** What to hand `spawn` for one request. */
export interface SpawnPlan {
  readonly args: readonly string[];
  readonly command: string;
  readonly windowsVerbatimArguments: boolean;
}

/**
 * Decides what to hand `spawn`, routing Windows shell scripts through `cmd.exe`.
 *
 * Node refuses to spawn a `.cmd` or `.bat` without a shell (CVE-2024-27980), and on Windows an
 * agent CLI is routinely exactly that kind of shim — Cursor's search-path entry is `cursor.cmd`.
 * Enabling `shell` for every command would hand the whole request to `cmd.exe` parsing, so only
 * scripts take this route, with the line escaped the way cross-spawn does: quote each argument
 * for `CommandLineToArgvW`, then caret-escape what `cmd.exe` itself interprets. The script path
 * is not quoted — spaces in it are caret-escaped instead, and `cmd.exe` resolves the rest.
 */
export function planSpawn(
  command: string,
  args: readonly string[],
  platform: EnvironmentPlatform,
): SpawnPlan {
  if (platform !== "win32" || !WINDOWS_SCRIPT_PATTERN.test(command)) {
    return { args, command, windowsVerbatimArguments: false };
  }

  const line = [escapeCmdCommand(command), ...args.map(escapeCmdArgument)].join(" ");
  return {
    args: ["/d", "/s", "/c", `"${line}"`],
    command: "cmd.exe",
    windowsVerbatimArguments: true,
  };
}

function escapeCmdCommand(command: string): string {
  return command.replace(CMD_METACHARACTER_PATTERN, "^$1");
}

function escapeCmdArgument(argument: string): string {
  // Double the backslashes before every quote and at the end, so the wrapping quotes survive
  // `CommandLineToArgvW`, then escape the result for `cmd.exe`.
  const quotable = argument.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\*)$/u, "$1$1");
  return `"${quotable}"`.replace(CMD_METACHARACTER_PATTERN, "^$1");
}
