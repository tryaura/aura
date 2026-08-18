import type { TelemetryEvent, TelemetrySink } from "@tryaura/aura-sdk";

/** Milliseconds the final flush may take before undelivered events are dropped. */
const DEFAULT_FLUSH_TIMEOUT_MS = 2000;

/**
 * A {@link TelemetryEvent} before the recorder stamps the envelope fields it owns.
 *
 * Distributed over the union so each member keeps its discriminant.
 */
type TelemetryEventDraft = TelemetryEvent extends infer E
  ? E extends TelemetryEvent
    ? Omit<E, "at" | "distroVersion">
    : never
  : never;

/**
 * The CLI's internal wrapper around a distribution's sink.
 *
 * Commands record drafts; the recorder stamps `at` and `distroVersion` and shields the run from
 * the sink: a throwing `record` is swallowed per event, and `flush` is raced against a bounded
 * timer and abort signal so a stalled sink can never hold the process open. Neither method ever
 * throws, and nothing here touches any stream.
 */
export interface TelemetryRecorder {
  readonly flush: () => Promise<void>;
  readonly record: (event: TelemetryEventDraft) => void;
}

/** Everything {@link createTelemetryRecorder} needs. */
export interface TelemetryRecorderOptions {
  /** Stamped onto every event. Absent when the distribution declares no version. */
  readonly distroVersion: string | undefined;
  /** Bound on the final flush. Defaults to {@link DEFAULT_FLUSH_TIMEOUT_MS}; injectable for tests. */
  readonly flushTimeoutMs?: number | undefined;
  /** The injected clock. */
  readonly now: () => Date;
  /** The distribution's sink. Absent, every method is a no-op. */
  readonly sink: TelemetrySink | undefined;
}

/** Creates the run's single {@link TelemetryRecorder}. */
export function createTelemetryRecorder(options: TelemetryRecorderOptions): TelemetryRecorder {
  const { sink } = options;
  if (sink === undefined) {
    return { flush: () => Promise.resolve(), record: () => undefined };
  }

  const flushTimeoutMs = options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
  return {
    flush: () => boundedFlush(sink, flushTimeoutMs),
    record: (event) => {
      try {
        sink.record({
          ...event,
          at: options.now().toISOString(),
          ...(options.distroVersion === undefined ? {} : { distroVersion: options.distroVersion }),
        });
      } catch {
        // A sink can never fail a run.
      }
    },
  };
}

/**
 * Whether the invoking environment permits telemetry at all.
 *
 * `DO_NOT_TRACK` set to anything non-empty other than `"0"`, or `AURA_TELEMETRY=off`, disables
 * the sink before it sees a single event. Checked by the CLI rather than the sink so no
 * distribution can decide otherwise.
 */
export function telemetryEnabled(
  environmentVariables: Readonly<Record<string, string | undefined>>,
): boolean {
  const doNotTrack = environmentVariables["DO_NOT_TRACK"];
  if (doNotTrack !== undefined && doNotTrack !== "" && doNotTrack !== "0") {
    return false;
  }
  return environmentVariables["AURA_TELEMETRY"] !== "off";
}

/**
 * Resolves when the sink's flush settles or the bound expires, whichever comes first.
 *
 * The timer is cleared once the race settles so a fast flush never leaves a pending timeout
 * holding the process open for the full bound.
 */
async function boundedFlush(sink: TelemetrySink, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve();
    }, timeoutMs);
  });
  try {
    await Promise.race([
      Promise.resolve()
        .then(() => sink.flush(controller.signal))
        .catch(() => undefined),
      expired,
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
