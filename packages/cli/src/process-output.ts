import type { Writable } from "node:stream";

interface ProcessOutputGuard {
  onFailure: (error: unknown) => void;
}

const GUARDS = new WeakMap<Writable, ProcessOutputGuard>();

/**
 * Uses an injected output unchanged, or equips the process-owned fallback for a stream failure.
 *
 * A downstream pipe closing is normal CLI control flow — `aura check | head` is a user reading the
 * top of a report, not a run that went wrong — so it is swallowed and the run keeps the exit code
 * it earned. Every other failure reaches `onFailure`, which owns how the run reports it. Nothing
 * here ends the process: an exit from a stream callback would publish a verdict the caller has not
 * finished computing, and a closed pipe would then report every failing machine as clean.
 */
export function resolveProcessOutput<T extends Writable>(
  injected: T | undefined,
  fallback: T,
  onFailure: (error: unknown) => void,
): T {
  if (injected !== undefined) {
    return injected;
  }
  const guard = GUARDS.get(fallback);
  if (guard !== undefined) {
    // One listener per stream for the life of the process, but always the current run's reporter.
    guard.onFailure = onFailure;
    return fallback;
  }
  const installed: ProcessOutputGuard = { onFailure };
  GUARDS.set(fallback, installed);
  fallback.on("error", (error: unknown) => {
    if (!isClosedPipe(error)) {
      installed.onFailure(error);
    }
  });
  return fallback;
}

function isClosedPipe(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EPIPE";
}
