import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isRecord } from "./guards.js";
import { ANY_ARGUMENT, type ShimArgument, type ShimResponse } from "./types.js";

const COMMAND_NAME = /^[A-Za-z0-9._+-]+$/u;
const RESERVED_NAMES: ReadonlySet<string> = new Set([".", ".."]);
const RECORD_FORMAT = "aura-testkit-v1";
const RECORD_LIMIT_BYTES = 2_048;

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
 * Each invocation is one LF-terminated ASCII record containing the format version, argument count,
 * and one base64-encoded UTF-8 field per argument, separated by tabs. The shim appends the complete
 * record with one `printf`, so concurrent invocations cannot interleave individual fields.
 *
 * A missing log means the seeded shim has not run. Invalid command names and malformed or truncated
 * records throw instead of being conflated with that valid empty state.
 */
export async function readInvocations(
  logDir: string,
  command: string,
): Promise<readonly (readonly string[])[]> {
  // The command reaches this function from a caller's argument and is about to be joined onto a
  // path, so it is checked here as well as where the shim was declared.
  if (!isPortableCommandName(command)) {
    throw new Error(`Shim command must be a portable executable name. Received: ${command}`);
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

  const invocations: (readonly string[])[] = [];
  const records = log.split("\n");
  if (records.pop() !== "") {
    throw unreadableInvocationLog(command);
  }

  for (const record of records) {
    invocations.push(parseInvocationRecord(command, record));
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
    `aura_record="${RECORD_FORMAT}\t$#"`,
    'for aura_recorded in "$@"; do',
    `  aura_encoded=$(printf '%s' "$aura_recorded" | /usr/bin/base64 | /usr/bin/tr -d '\\r\\n')`,
    '  aura_record="${aura_record}\t${aura_encoded}"',
    "done",
    'aura_record="${aura_record}\n"',
    "aura_record_length=${#aura_record}",
    `if [ "$aura_record_length" -gt ${String(RECORD_LIMIT_BYTES)} ]; then`,
    `  aura_record="${RECORD_FORMAT}\ttruncated\t\${aura_record_length}\n"`,
    "fi",
    `printf '%s' "$aura_record" >> ${shellQuote(logPath)}`,
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

function isUnsignedInteger(value: string): boolean {
  return /^(?:0|[1-9][0-9]*)$/u.test(value);
}

function parseInvocationRecord(command: string, record: string): readonly string[] {
  const fields = record.split("\t");
  if (fields[0] !== RECORD_FORMAT) {
    throw unreadableInvocationLog(command);
  }
  if (fields[1] === "truncated") {
    throwTruncatedInvocation(command, fields);
  }
  return parseInvocationFields(command, fields);
}

function throwTruncatedInvocation(command: string, fields: readonly string[]): never {
  const recordLength = fields[2];
  if (fields.length !== 3 || recordLength === undefined || !isUnsignedInteger(recordLength)) {
    throw unreadableInvocationLog(command);
  }
  throw new Error(
    `Shim ${command} invocation produced a ${recordLength}-byte log record, exceeding the ` +
      `${String(RECORD_LIMIT_BYTES)}-byte atomic limit. Reduce the invocation's arguments.`,
  );
}

function parseInvocationFields(command: string, fields: readonly string[]): readonly string[] {
  const countField = fields[1];
  if (countField === undefined || !isUnsignedInteger(countField)) {
    throw unreadableInvocationLog(command);
  }
  const count = Number(countField);
  if (!Number.isSafeInteger(count) || fields.length !== count + 2) {
    throw unreadableInvocationLog(command);
  }
  return Object.freeze(fields.slice(2).map((field) => decodeArgument(command, field)));
}

function decodeArgument(command: string, value: string): string {
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw unreadableInvocationLog(command);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw unreadableInvocationLog(command);
  }
}

function unreadableInvocationLog(command: string): Error {
  return new Error(`Shim ${command} wrote an invocation log this runner cannot read.`);
}
