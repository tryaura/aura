/**
 * Where a configuration artifact lives.
 *
 * `global` is user-level state under the home directory. `project` is state committed to, or
 * living beside, the current workspace.
 */
export type Scope = "global" | "project";

/** How serious a finding is. Presentation and exit codes are core's concern, not the check's. */
export type Severity = "error" | "info" | "warn";

/**
 * How much of a check's remediation can be automated.
 *
 * `auto` means `Check.fix` returns a complete plan. `guided` means the plan is partial and
 * `FixPlan.manualSteps` carries the rest. `manual` means the check has no `fix` at all.
 */
export type Fixability = "auto" | "guided" | "manual";

/** A JSON scalar. */
export type JsonPrimitive = boolean | null | number | string;

/** Any value that survives a `JSON.stringify` / `JSON.parse` round trip. */
export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

/**
 * A JSON object.
 *
 * Values typed as `JsonObject` are serialized into reports, logs, and CI output. Never place
 * credentials, tokens, or raw file contents in one.
 */
export type JsonObject = Readonly<Record<string, JsonValue>>;
