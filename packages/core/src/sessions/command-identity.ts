/**
 * The bounded (tool, command, subcommand) identity a tool call is folded by.
 *
 * Fidelity matters here: "git" alone hides that `git diff` is the bottleneck. A subcommand is
 * taken only for executables known to route through one, and only when the token looks like a
 * subcommand, so arbitrary argument text never becomes an identity.
 */
export interface CommandIdentity {
  readonly command: string | undefined;
  readonly subcommand: string | undefined;
  readonly tool: string;
}

/** Executables whose first bare argument names a subcommand worth tracking separately. */
const SUBCOMMAND_HEADS = new Set([
  "bun",
  "bundle",
  "cargo",
  "docker",
  "gh",
  "git",
  "go",
  "kubectl",
  "make",
  "mix",
  "npm",
  "npx",
  "pip",
  "pnpm",
  "poetry",
  "terraform",
  "uv",
  "yarn",
]);

/** Package runners where `run <script>` means the script is the real subcommand. */
const RUNNER_HEADS = new Set(["bun", "npm", "pnpm", "yarn"]);

const SUBCOMMAND_TOKEN = /^[a-z][a-z0-9:._-]{0,24}$/u;

/** The first subcommand token of one simple shell command, when its executable is known. */
export function shellSubcommand(command: string | undefined, head: string): string | undefined {
  if (command === undefined || !SUBCOMMAND_HEADS.has(head)) {
    return undefined;
  }
  for (const token of command.trim().split(/\s+/u).slice(1)) {
    if (token.startsWith("-")) {
      continue;
    }
    if (!SUBCOMMAND_TOKEN.test(token)) {
      return undefined;
    }
    if (RUNNER_HEADS.has(head) && token === "run") {
      continue;
    }
    return token;
  }
  return undefined;
}

/** The fold identity of one pending call: shell calls carry their executable, others do not. */
export function callCommandIdentity(call: {
  readonly label: string;
  readonly subcommand: string | undefined;
  readonly tool: string;
}): CommandIdentity {
  const command = call.tool === "shell" && call.label !== "shell" ? call.label : undefined;
  return { command, subcommand: call.subcommand, tool: call.tool };
}
