import type { Adapter } from "@tryaura/aura-sdk";

import type { WizardIo, WizardLoadStatus, WizardLoadUpdate } from "./wizard-types.js";

/** What the loading frame says while the machine scan finishes. */
const SCAN_PROMPT = "Scanning this machine…";

/**
 * Starts the boot scan immediately and defers the waiting to a wizard loading frame.
 *
 * The scan begins before any prompt so its slowest probes overlap the user's reading time, but a
 * loading frame can only exist once the wizard is ready to paint one. This tracker holds the gap
 * between the two: adapter progress reported before the frame opens is buffered and replayed into
 * it, progress after flows through live, and a scan that settles before the wizard needs it skips
 * the frame entirely — the same contract as a memoized skill listing.
 *
 * The returned settle function is the only consumer of the scan's outcome. A rejection while a
 * prompt is still open is held for it rather than crashing the process as unhandled; settle
 * rethrows it where boot's caller already handles scan failures.
 */
export function trackBootScan<T>(
  adapters: readonly Adapter[],
  start: (report: (adapterId: string, status: WizardLoadStatus) => void) => Promise<T>,
): (io: WizardIo) => Promise<T> {
  const statuses = new Map<string, WizardLoadStatus>();
  let frame: WizardLoadUpdate | undefined;
  let settled = false;

  const pending = start((adapterId, status) => {
    statuses.set(adapterId, status);
    frame?.(adapterId, status);
  });
  pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  return (io) => {
    // No adapters means no rows to animate; the settled case skips the frame like a memoized
    // skill listing does. Both await the same pending scan, so failures surface identically.
    if (settled || adapters.length === 0) {
      return pending;
    }
    return io.load(
      {
        items: adapters.map((adapter) => ({ id: adapter.id, label: adapter.displayName })),
        prompt: SCAN_PROMPT,
      },
      (update) => {
        for (const [adapterId, status] of statuses) {
          update(adapterId, status);
        }
        frame = update;
        return pending;
      },
    );
  };
}
