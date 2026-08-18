import { appendFile } from "node:fs/promises";

import type { TelemetryEvent, TelemetrySink } from "@tryaura/aura-sdk";

/**
 * A fake telemetry sink: it appends each run's events to an NDJSON file instead of an org
 * endpoint, so the smoke test can read back exactly what a real collector would have received.
 *
 * It follows the {@link TelemetrySink} contract a production sink must honor too: `record` only
 * buffers and returns immediately, delivery happens once in the end-of-run `flush` (bounded by the
 * CLI to about two seconds), and neither method ever throws or touches the process streams — a
 * sink can never fail or noise up a run. A real distribution would swap the `appendFile` for an
 * HTTP delivery, or use `createHttpTelemetrySink` from `@tryaura/aura-cli` directly. This local
 * fixture checks the CLI's abort signal before its one bounded filesystem write.
 */
export function createAcmeTelemetrySink(filePath: string): TelemetrySink {
  const buffered: TelemetryEvent[] = [];

  return {
    flush: async (signal) => {
      const events = buffered.splice(0);
      if (events.length === 0 || signal.aborted) {
        return;
      }
      try {
        await appendFile(
          filePath,
          `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
          "utf8",
        );
      } catch {
        // Telemetry is best-effort: an unwritable file must never fail the run.
      }
    },
    record: (event) => {
      buffered.push(event);
    },
  };
}
