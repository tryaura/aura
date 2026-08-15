import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isRecord } from "./guards.js";
import { ANY_ARGUMENT, type ShimArgument, type ShimResponse } from "./types.js";

const COMMAND_NAME = /^[A-Za-z0-9._+-]+$/u;
const RESERVED_NAMES: ReadonlySet<string> = new Set([".", ".."]);

interface WriteShimOptions {
  readonly command: string;
  /** Directory the shim appends its invocation log to. */
  readonly logDir: string;
  /** Directory the shim itself is written to, which is the seeded PATH. */
  readonly pathDir: string;
  readonly responses: readonly ShimResponse[];
}

export async function writeShim(options: WriteShimOptions): Promise<void> {
  const { command, logDir, pathDir, responses } = options;
  validateShim(command, responses);
  const path = join(pathDir, command);
  await writeFile(path, renderShim(command, join(logDir, command), responses), "utf8");
  await chmod(path, 0o755);
}

/**
 * Reads back every invocation one shim recorded.
 *
 * The log frames each record as its argument count followed by that many arguments, all
 * NUL-terminated. Arguments cannot contain NUL — {@link validateShim} rejects that — so the framing
 * stays unambiguous for empty arguments and for arguments holding newlines.
 */
export async function readInvocations(
  logDir: string,
  command: string,
): Promise<readonly (readonly string[])[]> {
  // The command reaches this function from a caller's argument and is about to be joined onto a
  // path, so it is checked here as well as where the shim was declared.
  if (!isPortableCommandName(command)) {
    return [];
  }

  let log: string;
  try {
    log = await readFile(join(logDir, command), "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }
    throw error;
  }

  const fields = log.split("\0");
  fields.pop();
  const invocations: (readonly string[])[] = [];
  let cursor = 0;
  while (cursor < fields.length) {
    const count = Number(fields[cursor]);
    if (!Number.isInteger(count) || count < 0 || cursor + 1 + count > fields.length) {
      throw new Error(`Shim ${command} wrote an invocation log this runner cannot read.`);
    }
    invocations.push(Object.freeze(fields.slice(cursor + 1, cursor + 1 + count)));
    cursor += 1 + count;
  }
  return Object.freeze(invocations);
}

export function validateShim(command: string, responses: readonly ShimResponse[]): void {
  if (!isPortableCommandName(command)) {
    throw new Error(`Shim command must be a portable executable name. Received: ${command}`);
  }
  if (responses.length === 0) {
    throw new Error(`Shim ${command} must declare at least one response.`);
  }

  const invocations = new Set<string>();
  for (const response of responses) {
    const key = describeArgs(response.args);
    if (invocations.has(key)) {
      throw new Error(`Shim ${command} declares the same arguments more than once: ${key}`);
    }
    invocations.add(key);
    validateResponse(command, response);
  }
}

/** The name has to be a single path segment: `.` and `..` pass the character test but are not. */
function isPortableCommandName(command: string): boolean {
  return COMMAND_NAME.test(command) && !RESERVED_NAMES.has(command);
}

function describeArgs(args: readonly ShimArgument[]): string {
  return JSON.stringify(args.map((argument) => (isAnyArgument(argument) ? null : argument)));
}

function isAnyArgument(argument: ShimArgument): argument is typeof ANY_ARGUMENT {
  return argument === ANY_ARGUMENT;
}

function validateResponse(command: string, response: ShimResponse): void {
  const exitCode = response.exitCode ?? 0;
  if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
    throw new Error(`Shim ${command} exit code must be an integer from 0 to 255.`);
  }

  const literals = response.args.filter((argument) => !isAnyArgument(argument));
  for (const value of [command, ...literals, response.stdout ?? "", response.stderr ?? ""]) {
    if (value.includes("\0")) {
      throw new Error(`Shim ${command} values cannot contain a NUL character.`);
    }
  }
}

function renderShim(command: string, logPath: string, responses: readonly ShimResponse[]): string {
  return [
    "#!/bin/sh",
    "{",
    `  printf '%s\\0' "$#"`,
    '  for aura_recorded in "$@"; do',
    `    printf '%s\\0' "$aura_recorded"`,
    "  done",
    `} >> ${shellQuote(logPath)}`,
    ...responses.map(renderResponse),
    `printf '%s' ${shellQuote(`aura-testkit: unmatched invocation: ${command}`)} >&2`,
    'for aura_reported in "$@"; do',
    '  printf " %s" "$aura_reported" >&2',
    "done",
    "printf '\\n' >&2",
    "exit 2",
    "",
  ].join("\n");
}

function renderResponse(response: ShimResponse): string {
  const conditions = [
    `[ "$#" -eq ${String(response.args.length)} ]`,
    ...response.args.flatMap((argument, index) =>
      isAnyArgument(argument) ? [] : [`[ "$${String(index + 1)}" = ${shellQuote(argument)} ]`],
    ),
  ];
  return [
    `if ${conditions.join(" && ")}; then`,
    ...(response.stdout === undefined ? [] : [`  printf '%s' ${shellQuote(response.stdout)}`]),
    ...(response.stderr === undefined ? [] : [`  printf '%s' ${shellQuote(response.stderr)} >&2`]),
    `  exit ${String(response.exitCode ?? 0)}`,
    "fi",
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error["code"] === "ENOENT";
}
