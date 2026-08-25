import type { CliCommandInvocation } from "./types.js";

/**
 * Typed access to a distribution command's parsed flag values.
 *
 * `invocation.flags` is a plain record, so a misspelled key reads as `undefined` and every value
 * needs narrowing by hand. Each helper narrows to its declared kind and throws on a flag the
 * definition never declared with that kind — a build-time composition bug surfacing as an
 * operational failure, the same way an invalid definition fails the run at startup.
 */

/** The parsed value of a declared `boolean` flag; always present. */
export function booleanFlag(invocation: CliCommandInvocation, flag: string): boolean {
  const value = declaredValue(invocation, flag);
  if (typeof value !== "boolean") {
    throw new Error(`Flag "${flag}" is not declared as a boolean flag.`);
  }
  return value;
}

/** The parsed value of a declared `string` flag; absent when the run never gave it. */
export function stringFlag(invocation: CliCommandInvocation, flag: string): string | undefined {
  const value = declaredValue(invocation, flag);
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`Flag "${flag}" is not declared as a string flag.`);
  }
  return value;
}

/** The parsed values of a declared `array` flag; empty when the run never gave it. */
export function arrayFlag(invocation: CliCommandInvocation, flag: string): readonly string[] {
  const value = declaredValue(invocation, flag);
  if (!Array.isArray(value)) {
    throw new Error(`Flag "${flag}" is not declared as an array flag.`);
  }
  return value;
}

/**
 * The raw parsed value behind `flag`.
 *
 * Every declared flag has a key in the record even when its value is `undefined`, so a missing key
 * can only be a flag the definition never declared — most likely a typo in the caller.
 */
function declaredValue(
  invocation: CliCommandInvocation,
  flag: string,
): CliCommandInvocation["flags"][string] {
  if (!(flag in invocation.flags)) {
    throw new Error(`Flag "${flag}" is not declared on this command.`);
  }
  return invocation.flags[flag];
}
