import type { Writable } from "node:stream";

import { isTerminal } from "./command-support.js";

const COLOR_DEPTH = 8;

export interface ColorArguments {
  readonly argv: readonly string[];
  readonly noColor: boolean;
}

/** Consumes Aura's global color flag without treating positional arguments after `--` as flags. */
export function extractColorArguments(argv: readonly string[]): ColorArguments {
  const resolved: string[] = [];
  let noColor = false;
  let options = true;

  for (const argument of argv) {
    if (options && argument === "--") {
      options = false;
      resolved.push(argument);
    } else if (options && argument === "--no-color") {
      noColor = true;
    } else {
      resolved.push(argument);
    }
  }

  return { argv: resolved, noColor };
}

/** Resolves automatic color support from environment policy and the actual destination stream. */
export function detectColorDepth(
  environmentVariables: Readonly<Record<string, string | undefined>>,
  stdout: Writable,
): number {
  if (isSet(environmentVariables["NO_COLOR"])) {
    return 0;
  }

  const forceColor = environmentVariables["FORCE_COLOR"];
  if (forceColor === "0") {
    return 0;
  }
  if (isPositiveInteger(forceColor)) {
    return COLOR_DEPTH;
  }

  if (isEnabled(environmentVariables["CI"])) {
    return 0;
  }
  if (environmentVariables["TERM"]?.toLowerCase() === "dumb") {
    return 0;
  }
  return isTerminal(stdout) ? COLOR_DEPTH : 0;
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

/** A flag variable a script deliberately turned off is off, not merely present. */
function isEnabled(value: string | undefined): boolean {
  return isSet(value) && value !== "0" && value?.toLowerCase() !== "false";
}

function isPositiveInteger(value: string | undefined): boolean {
  return value !== undefined && /^[1-9]\d*$/.test(value);
}
