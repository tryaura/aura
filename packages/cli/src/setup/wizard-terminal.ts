import process from "node:process";
import type { Readable, Writable } from "node:stream";

const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";

/**
 * Signals that end the process without running `exit` handlers.
 *
 * Ctrl+c is deliberately not among the cases these cover: raw mode delivers it as an ordinary
 * keypress, so the form aborts through its own state machine and no signal is ever raised.
 */
const TERMINATING_SIGNALS: readonly NodeJS.Signals[] = Object.freeze([
  "SIGHUP",
  "SIGINT",
  "SIGTERM",
]);

/** A stream whose line discipline the wizard can take over. */
type RawModeReadable = Readable & { isTTY: boolean; setRawMode: (mode: boolean) => unknown };

/** The wizard's hold on the terminal, given back however the form ends. */
export interface TerminalClaim {
  /** Restores line discipline and the cursor, and detaches every hook. Safe to call twice. */
  readonly release: () => void;
}

export function supportsRawMode(stdin: Readable): stdin is RawModeReadable {
  return (
    "isTTY" in stdin &&
    stdin.isTTY === true &&
    "setRawMode" in stdin &&
    typeof stdin.setRawMode === "function"
  );
}

/**
 * Takes the terminal into raw mode with the cursor hidden, registering every way of giving it back.
 *
 * A terminal left in raw mode with no cursor is unusable, so the wizard has to hand it back on
 * every way out — and the ways out it cannot see from a `finally` are the ones that matter. `exit`
 * covers `process.exit` and a natural end but does not run for a signal, so each terminating
 * signal is hooked separately. Registering a signal listener suppresses Node's default
 * termination, so the handler detaches, restores, and re-raises: the process still dies from that
 * signal, with the status whatever is waiting on it expects, rather than surviving a `kill` it was
 * never meant to intercept.
 *
 * Every hook lives only as long as the claim. A run whose stdin is not a TTY takes no claim at
 * all, so headless and scripted runs never touch process-wide state.
 */
export function claimTerminal(stdin: RawModeReadable, stdout: Writable): TerminalClaim {
  const handlers = new Map<NodeJS.Signals, () => void>();

  const restore = (): void => {
    stdin.setRawMode(false);
    stdout.write(SHOW_CURSOR);
  };
  const detach = (): void => {
    process.off("exit", restore);
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
    handlers.clear();
  };

  stdin.setRawMode(true);
  stdout.write(HIDE_CURSOR);
  process.once("exit", restore);
  for (const signal of TERMINATING_SIGNALS) {
    const handler = (): void => {
      detach();
      restore();
      process.kill(process.pid, signal);
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }

  return {
    release: () => {
      detach();
      restore();
    },
  };
}
