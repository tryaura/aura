import type {
  HttpFailureReason,
  HttpPostRequest,
  HttpPostResult,
  TelemetryEvent,
  TelemetrySink,
} from "@tryaura/aura-sdk";
import { createHttpPost, vetHttpUrl } from "@tryaura/core";

/** Events per POST when {@link HttpTelemetrySinkOptions.maxBatch} is omitted. */
const DEFAULT_MAX_BATCH = 50;

/** Buffered-event cap when {@link HttpTelemetrySinkOptions.maxBufferedEvents} is omitted. */
const DEFAULT_MAX_BUFFERED_EVENTS = 1000;

/** Per-POST timeout when {@link HttpTelemetrySinkOptions.timeoutMs} is omitted, sized to fit the CLI's flush budget. */
const DEFAULT_POST_TIMEOUT_MS = 2000;

/** A privacy-safe reason one HTTP delivery was dropped. */
export type HttpTelemetryDeliveryFailure =
  | { readonly kind: "http-status"; readonly status: number }
  | { readonly kind: "transport"; readonly reason: HttpFailureReason | "rejected" };

/** Configuration for {@link createHttpTelemetrySink}. */
export interface HttpTelemetrySinkOptions {
  /**
   * Headers sent with every delivery, such as a public write-only ingestion key or a per-user
   * credential acquired at runtime.
   *
   * A compiled distribution cannot keep an embedded secret. Additional headers are sent verbatim,
   * the transport enforces `content-type: application/json`, and results and diagnostics never echo
   * header values.
   */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Events per POST. Defaults to {@link DEFAULT_MAX_BATCH}; must be a positive safe integer. */
  readonly maxBatch?: number | undefined;
  /**
   * Events held before `record` starts dropping the newest.
   *
   * Defaults to {@link DEFAULT_MAX_BUFFERED_EVENTS} and must be a positive safe integer. A cap
   * rather than an error: telemetry must never grow without bound or fail the run that produced it.
   */
  readonly maxBufferedEvents?: number | undefined;
  /**
   * Receives delivery failures without event data, the endpoint URL, or headers.
   *
   * The callback is observational only: throws are swallowed and can never fail the CLI run.
   */
  readonly onDeliveryFailure?: ((failure: HttpTelemetryDeliveryFailure) => void) | undefined;
  /** Transport override for tests. Defaults to the kernel's bounded TLS-only client. */
  readonly post?: ((request: HttpPostRequest) => Promise<HttpPostResult>) | undefined;
  /** Positive finite milliseconds per POST. Defaults to {@link DEFAULT_POST_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined;
  /**
   * Absolute `https:` endpoint URL without embedded credentials. Plain `http:` is refused except
   * for literal loopback hosts. Invalid values throw when the sink is created.
   */
  readonly url: string;
}

/**
 * A {@link TelemetrySink} that batches events and delivers them as JSON over HTTPS.
 *
 * `record` only buffers; nothing leaves the machine until the CLI's end-of-run `flush`, which
 * posts `{ events, kind: "aura-telemetry", schemaVersion: 1 }` in batches. Delivery is
 * best-effort by design: a failed or non-2xx batch is dropped without retry — the process is
 * exiting — and neither method ever throws or rejects. Configuration errors throw immediately;
 * runtime delivery failures reach the optional privacy-safe observer.
 */
export function createHttpTelemetrySink(options: HttpTelemetrySinkOptions): TelemetrySink {
  validateUrl(options.url);
  const post = options.post ?? createHttpPost();
  const maxBatch = positiveInteger(options.maxBatch, DEFAULT_MAX_BATCH, "maxBatch");
  const maxBufferedEvents = positiveInteger(
    options.maxBufferedEvents,
    DEFAULT_MAX_BUFFERED_EVENTS,
    "maxBufferedEvents",
  );
  const timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_POST_TIMEOUT_MS, "timeoutMs");
  const buffered: TelemetryEvent[] = [];

  return {
    flush: async (signal) => {
      const events = buffered.splice(0);
      for (let start = 0; start < events.length; start += maxBatch) {
        if (signal.aborted) {
          break;
        }
        await deliver(
          post,
          {
            body: JSON.stringify({
              events: events.slice(start, start + maxBatch),
              kind: "aura-telemetry",
              schemaVersion: 1,
            }),
            ...(options.headers === undefined ? {} : { headers: options.headers }),
            signal,
            timeoutMs,
            url: options.url,
          },
          options.onDeliveryFailure,
        );
      }
    },
    record: (event) => {
      if (buffered.length < maxBufferedEvents) {
        buffered.push(event);
      }
    },
  };
}

/** Delivers one batch and reports only a closed, privacy-safe failure reason. */
async function deliver(
  post: (request: HttpPostRequest) => Promise<HttpPostResult>,
  request: HttpPostRequest,
  onFailure: HttpTelemetrySinkOptions["onDeliveryFailure"],
): Promise<void> {
  let result: HttpPostResult;
  try {
    result = await post(request);
  } catch {
    notifyFailure(onFailure, { kind: "transport", reason: "rejected" });
    return;
  }
  if (result.kind === "failure") {
    notifyFailure(onFailure, { kind: "transport", reason: result.reason });
  } else if (result.status < 200 || result.status >= 300) {
    notifyFailure(onFailure, { kind: "http-status", status: result.status });
  }
}

/** A sink observer cannot affect the command it watches. */
function notifyFailure(
  observer: HttpTelemetrySinkOptions["onDeliveryFailure"],
  failure: HttpTelemetryDeliveryFailure,
): void {
  try {
    observer?.(failure);
  } catch {
    // Observability is best-effort too.
  }
}

/** Refuses a broken or credential-bearing endpoint when the distribution is composed. */
function validateUrl(raw: string): void {
  const vetted = vetHttpUrl(raw);
  if (!(vetted instanceof URL)) {
    throw new TypeError(
      "Telemetry URL must be absolute and use https (plain http is loopback-only).",
    );
  }
  if (vetted.username !== "" || vetted.password !== "") {
    throw new TypeError("Telemetry URL must not contain embedded credentials.");
  }
}

/** Supplies the default or refuses a non-positive, non-finite, or fractional count. */
function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

/** Supplies the default or refuses a timeout that cannot bound work. */
function positiveNumber(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number.`);
  }
  return value;
}
