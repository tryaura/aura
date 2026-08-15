import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ShimResponse } from "./types.js";

const COMMAND_NAME = /^[A-Za-z0-9._+-]+$/u;

export async function writeShim(
  directory: string,
  command: string,
  responses: readonly ShimResponse[],
): Promise<void> {
  validateShim(command, responses);
  const path = join(directory, command);
  await writeFile(path, renderShim(command, responses), "utf8");
  await chmod(path, 0o755);
}

export function validateShim(command: string, responses: readonly ShimResponse[]): void {
  if (!COMMAND_NAME.test(command)) {
    throw new Error(`Shim command must be a portable executable name. Received: ${command}`);
  }
  if (responses.length === 0) {
    throw new Error(`Shim ${command} must declare at least one response.`);
  }

  const invocations = new Set<string>();
  for (const response of responses) {
    const key = JSON.stringify(response.args);
    if (invocations.has(key)) {
      throw new Error(`Shim ${command} declares the same arguments more than once: ${key}`);
    }
    invocations.add(key);
    validateResponse(command, response);
  }
}

function validateResponse(command: string, response: ShimResponse): void {
  const exitCode = response.exitCode ?? 0;
  if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
    throw new Error(`Shim ${command} exit code must be an integer from 0 to 255.`);
  }

  for (const value of [command, ...response.args, response.stdout ?? "", response.stderr ?? ""]) {
    if (value.includes("\0")) {
      throw new Error(`Shim ${command} values cannot contain a NUL character.`);
    }
  }
}

function renderShim(command: string, responses: readonly ShimResponse[]): string {
  const cases = responses.map(renderResponse).join("\n");
  return [
    "#!/bin/sh",
    cases,
    `printf '%s' ${shellQuote(`aura-testkit: unmatched invocation: ${command}`)} >&2`,
    'for argument in "$@"; do',
    '  printf " %s" "$argument" >&2',
    "done",
    "printf '\\n' >&2",
    "exit 2",
    "",
  ].join("\n");
}

function renderResponse(response: ShimResponse): string {
  const conditions = [
    `[ "$#" -eq ${String(response.args.length)} ]`,
    ...response.args.map(
      (argument, index) => `[ "$${String(index + 1)}" = ${shellQuote(argument)} ]`,
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
