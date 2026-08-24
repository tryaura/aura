import type {
  TelemetryAppState,
  TelemetryCheckCounts,
  TelemetryCheckFlags,
  TelemetryCheckState,
  TelemetryCommand,
  TelemetryEnvelope,
  TelemetryFixOutcome,
  TelemetryInstructionAction,
  TelemetrySetupActions,
} from "./telemetry.js";

/** Distribution-owned labels: the vocabulary a sink groups by, so bounded and free of free text. */
const TELEMETRY_LABEL = /^[a-z][a-z0-9-]{0,63}$/u;

/** Entries one labelled record may carry, so a payload stays a fixed vocabulary and not a blob. */
const MAX_LABELLED_ENTRIES = 32;

const ISO_INSTANT =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/u;

export function isTelemetryAppState(value: unknown): value is TelemetryAppState {
  return (
    isExactRecord(value, ["appId", "installed"]) &&
    isIdentifier(value["appId"]) &&
    typeof value["installed"] === "boolean"
  );
}

export function isTelemetryCheckState(value: unknown): value is TelemetryCheckState {
  return (
    isExactRecord(value, ["checkId", "errors", "informational", "state", "warnings"]) &&
    isIdentifier(value["checkId"]) &&
    isNonNegativeInteger(value["errors"]) &&
    isNonNegativeInteger(value["informational"]) &&
    isOneOf(value["state"], ["failed", "findings", "passed"]) &&
    isNonNegativeInteger(value["warnings"])
  );
}

export function isTelemetryCheckCounts(value: unknown): value is TelemetryCheckCounts {
  return (
    isExactRecord(value, ["errors", "informational", "passed", "warnings"]) &&
    isNonNegativeInteger(value["errors"]) &&
    isNonNegativeInteger(value["informational"]) &&
    isNonNegativeInteger(value["passed"]) &&
    isNonNegativeInteger(value["warnings"])
  );
}

export function isTelemetryCheckFlags(value: unknown): value is TelemetryCheckFlags {
  return (
    isExactRecord(value, ["dryRun", "fix", "interactive", "json", "online", "verbose"]) &&
    typeof value["dryRun"] === "boolean" &&
    typeof value["fix"] === "boolean" &&
    typeof value["interactive"] === "boolean" &&
    typeof value["json"] === "boolean" &&
    typeof value["online"] === "boolean" &&
    typeof value["verbose"] === "boolean"
  );
}

export function isTelemetryFixOutcome(value: unknown): value is TelemetryFixOutcome {
  return (
    isExactRecord(value, ["checkId", "status"]) &&
    isIdentifier(value["checkId"]) &&
    isOneOf(value["status"], ["applied", "failed", "partial", "planned"])
  );
}

export function isTelemetrySetupActions(value: unknown): value is TelemetrySetupActions {
  if (
    !isExactRecord(value, [], ["applications", "instructions", "mcpServers", "skills", "snippets"])
  ) {
    return false;
  }
  return (
    isOptional(value, "applications", isIdentifierArray) &&
    isOptional(value, "instructions", isInstructionActions) &&
    isOptional(value, "mcpServers", isTelemetryMcpActions) &&
    isOptional(value, "skills", isTelemetrySkillActions) &&
    isOptional(value, "snippets", isIdentifierArray)
  );
}

/** A distribution-owned label such as an event name, outcome, counter key, or flag key. */
export function isTelemetryLabel(value: unknown): value is string {
  return typeof value === "string" && TELEMETRY_LABEL.test(value);
}

/** A bounded record of {@link isTelemetryLabel} keys whose values all satisfy `isValue`. */
export function isLabelledRecord(
  value: unknown,
  isValue: (input: unknown) => boolean,
): value is Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    return false;
  }
  const entries = Object.entries(value);
  return (
    entries.length <= MAX_LABELLED_ENTRIES &&
    entries.every(([key, entry]) => isTelemetryLabel(key) && isValue(entry))
  );
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/**
 * The envelope of a distribution-registered command's event.
 *
 * `command` is the registered word rather than one of the built-in three, validated as a label so
 * an arbitrary string can never reach a sink through the one field the CLI stamps for the command.
 */
export function isDistroEnvelope(
  value: Readonly<Record<string, unknown>>,
): value is Readonly<Record<string, unknown>> & Omit<TelemetryEnvelope, "command"> {
  return (
    isIsoInstant(value["at"]) &&
    isTelemetryLabel(value["command"]) &&
    isOptional(value, "distroVersion", isIdentifier)
  );
}

export function isEnvelope(
  value: Readonly<Record<string, unknown>>,
  command?: TelemetryCommand,
): value is Readonly<Record<string, unknown>> & TelemetryEnvelope {
  return (
    isIsoInstant(value["at"]) &&
    (command === undefined
      ? isOneOf(value["command"], ["check", "setup", "undo"])
      : value["command"] === command) &&
    isOptional(value, "distroVersion", isIdentifier)
  );
}

export function isExactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    return false;
  }
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isOptional(
  value: Readonly<Record<string, unknown>>,
  key: string,
  predicate: (input: unknown) => boolean,
): boolean {
  return !Object.hasOwn(value, key) || predicate(value[key]);
}

export function isArrayOf<T>(
  value: unknown,
  predicate: (input: unknown) => input is T,
): value is readonly T[] {
  return Array.isArray(value) && value.every((item) => predicate(item));
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isOneOf<const T extends string>(
  value: unknown,
  candidates: readonly T[],
): value is T {
  return typeof value === "string" && candidates.some((candidate) => candidate === value);
}

function isInstructionActions(value: unknown): value is readonly TelemetryInstructionAction[] {
  return isArrayOf(value, isTelemetryInstructionAction);
}

function isTelemetryInstructionAction(value: unknown): value is TelemetryInstructionAction {
  return (
    isExactRecord(value, ["action"]) &&
    isOneOf(value["action"], ["blocked", "consolidate", "keep", "template"])
  );
}

function isTelemetryMcpActions(
  value: unknown,
): value is NonNullable<TelemetrySetupActions["mcpServers"]> {
  return (
    isExactRecord(value, ["catalogIds", "customCount"]) &&
    isIdentifierArray(value["catalogIds"]) &&
    isNonNegativeInteger(value["customCount"])
  );
}

function isTelemetrySkillActions(
  value: unknown,
): value is NonNullable<TelemetrySetupActions["skills"]> {
  return (
    isExactRecord(value, ["bundled", "externalCount"]) &&
    isArrayOf(value["bundled"], isBundledSkill) &&
    isNonNegativeInteger(value["externalCount"])
  );
}

function isBundledSkill(
  value: unknown,
): value is NonNullable<TelemetrySetupActions["skills"]>["bundled"][number] {
  return (
    isExactRecord(value, ["id", "source"]) &&
    isIdentifier(value["id"]) &&
    isPluginSource(value["source"])
  );
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function isIdentifierArray(value: unknown): value is readonly string[] {
  return isArrayOf(value, isIdentifier);
}

function isPluginSource(value: unknown): value is `plugin:${string}` {
  return isIdentifier(value) && value.startsWith("plugin:") && value.length > "plugin:".length;
}

function isIsoInstant(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const match = ISO_INSTANT.exec(value);
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return day <= daysInMonth(year, month);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
