import type { ParseState, PendingCall } from "./codex-parse-state.js";
import { asString, parseTranscriptRecord } from "./transcript-json.js";

const RUNNING_SESSION = /(?:Process running with session ID |SESSION_ID=)(\d+)/u;

export function runningShellSessionId(output: string): string | undefined {
  return RUNNING_SESSION.exec(output)?.[1];
}

export function shellContinuation(
  state: ParseState,
  rawArguments: unknown,
  at: number | undefined,
): PendingCall | undefined {
  const raw = asString(rawArguments);
  const parsed = raw === undefined ? undefined : parseTranscriptRecord(raw);
  const rawSessionId = parsed?.["session_id"];
  const sessionId =
    typeof rawSessionId === "number" ? String(rawSessionId) : asString(rawSessionId);
  const original = sessionId === undefined ? undefined : state.shellSessions.get(sessionId);
  return original === undefined ? undefined : { ...original, at, shellSessionId: sessionId };
}
