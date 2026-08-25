import type {
  CheckRunEvent,
  CommandFailedEvent,
  DistroCommandEvent,
  FixRunEvent,
  SetupRunEvent,
  TelemetryBatchV1,
  TelemetryEvent,
  UndoRunEvent,
} from "./telemetry.js";
import {
  isArrayOf,
  isBoolean,
  isDistroEnvelope,
  isEnvelope,
  isExactRecord,
  isLabelledRecord,
  isNonNegativeInteger,
  isNonNegativeNumber,
  isOptional,
  isRecord,
  isTelemetryAppState,
  isTelemetryCheckCounts,
  isTelemetryCheckFlags,
  isTelemetryCheckState,
  isTelemetryFixOutcome,
  isTelemetryLabel,
  isTelemetrySetupActions,
  isOneOf,
} from "./telemetry-decoder-values.js";

/**
 * Decodes the exact version-one telemetry wire shape.
 *
 * Exact key checks are a privacy boundary: a receiver using this decoder can persist the returned
 * value knowing that an unrecognized client field did not travel through alongside the documented
 * event. This validates the schema, not transport policy such as batch or body-size limits.
 */
export function decodeTelemetryBatchV1(value: unknown): TelemetryBatchV1 | undefined {
  return isTelemetryBatchV1(value) ? value : undefined;
}

function isTelemetryBatchV1(value: unknown): value is TelemetryBatchV1 {
  return (
    isExactRecord(value, ["events", "kind", "schemaVersion"]) &&
    value["kind"] === "aura-telemetry" &&
    value["schemaVersion"] === 1 &&
    isArrayOf(value["events"], isTelemetryEvent)
  );
}

function isTelemetryEvent(value: unknown): value is TelemetryEvent {
  if (!isRecord(value)) {
    return false;
  }
  switch (value["kind"]) {
    case "check-run":
      return isCheckRunEvent(value);
    case "command-failed":
      return isCommandFailedEvent(value);
    case "distro-command":
      return isDistroCommandEvent(value);
    case "fix-run":
      return isFixRunEvent(value);
    case "setup-run":
      return isSetupRunEvent(value);
    case "undo-run":
      return isUndoRunEvent(value);
    default:
      return false;
  }
}

function isCheckRunEvent(value: unknown): value is CheckRunEvent {
  return (
    isExactRecord(
      value,
      [
        "apps",
        "at",
        "checks",
        "command",
        "counts",
        "diagnosticCount",
        "durationMs",
        "exitCode",
        "flags",
        "kind",
      ],
      ["distroVersion"],
    ) &&
    isEnvelope(value, "check") &&
    value["kind"] === "check-run" &&
    isCheckRunCollections(value) &&
    isCheckRunResult(value)
  );
}

function isCheckRunCollections(value: Readonly<Record<string, unknown>>): boolean {
  return (
    isArrayOf(value["apps"], isTelemetryAppState) &&
    isArrayOf(value["checks"], isTelemetryCheckState) &&
    isTelemetryCheckCounts(value["counts"])
  );
}

function isCheckRunResult(value: Readonly<Record<string, unknown>>): boolean {
  return (
    isNonNegativeInteger(value["diagnosticCount"]) &&
    isNonNegativeNumber(value["durationMs"]) &&
    isNonNegativeInteger(value["exitCode"]) &&
    isTelemetryCheckFlags(value["flags"])
  );
}

function isFixRunEvent(value: unknown): value is FixRunEvent {
  return (
    isExactRecord(
      value,
      ["at", "command", "dryRun", "exitCode", "fixes", "interactive", "kind"],
      ["distroVersion"],
    ) &&
    isEnvelope(value, "check") &&
    value["kind"] === "fix-run" &&
    typeof value["dryRun"] === "boolean" &&
    isNonNegativeInteger(value["exitCode"]) &&
    isArrayOf(value["fixes"], isTelemetryFixOutcome) &&
    typeof value["interactive"] === "boolean"
  );
}

function isSetupRunEvent(value: unknown): value is SetupRunEvent {
  return (
    isExactRecord(
      value,
      ["at", "command", "durationMs", "exitCode", "kind", "outcome"],
      ["actions", "appliedOperationCount", "distroVersion"],
    ) &&
    isEnvelope(value, "setup") &&
    value["kind"] === "setup-run" &&
    isOptional(value, "actions", isTelemetrySetupActions) &&
    isOptional(value, "appliedOperationCount", isNonNegativeInteger) &&
    isNonNegativeNumber(value["durationMs"]) &&
    isNonNegativeInteger(value["exitCode"]) &&
    isOneOf(value["outcome"], [
      "aborted",
      "applied",
      "blocked",
      "converged",
      "declined",
      "dry-run",
      "unusable",
    ])
  );
}

function isUndoRunEvent(value: unknown): value is UndoRunEvent {
  return (
    isExactRecord(
      value,
      ["at", "command", "exitCode", "kind", "outcome"],
      ["distroVersion", "restoredOperationCount", "skippedBackupCount"],
    ) &&
    isEnvelope(value, "undo") &&
    value["kind"] === "undo-run" &&
    isNonNegativeInteger(value["exitCode"]) &&
    isOneOf(value["outcome"], [
      "declined",
      "dry-run",
      "failed",
      "listed",
      "nothing-to-undo",
      "refused",
      "restored",
    ]) &&
    isOptional(value, "restoredOperationCount", isNonNegativeInteger) &&
    isOptional(value, "skippedBackupCount", isNonNegativeInteger)
  );
}

/**
 * One event from a distribution-registered command.
 *
 * Every payload field is optional, so the exact-key check is doing most of the work: it is what
 * stops a distribution from widening its own events with fields a receiver would then persist.
 */
function isDistroCommandEvent(value: unknown): value is DistroCommandEvent {
  return (
    isExactRecord(
      value,
      ["at", "command", "event", "kind"],
      ["counts", "distroVersion", "durationMs", "exitCode", "flags", "outcome"],
    ) &&
    isDistroEnvelope(value) &&
    value["kind"] === "distro-command" &&
    isTelemetryLabel(value["event"]) &&
    isOptional(value, "counts", (counts) => isLabelledRecord(counts, isNonNegativeNumber)) &&
    isOptional(value, "durationMs", isNonNegativeNumber) &&
    isOptional(value, "exitCode", isNonNegativeInteger) &&
    isOptional(value, "flags", (flags) => isLabelledRecord(flags, isBoolean)) &&
    isOptional(value, "outcome", isTelemetryLabel)
  );
}

function isCommandFailedEvent(value: unknown): value is CommandFailedEvent {
  return (
    isExactRecord(value, ["at", "command", "exitCode", "kind"], ["distroVersion"]) &&
    isEnvelope(value) &&
    value["kind"] === "command-failed" &&
    isNonNegativeInteger(value["exitCode"])
  );
}
