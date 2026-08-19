import type { Environment, HttpGetRequest, HttpGetResult } from "@tryaura/aura-sdk";

export type AgenticRequestOutcome =
  | { readonly body: string; readonly kind: "text" }
  | { readonly body: Uint8Array; readonly kind: "bytes" }
  | { readonly kind: "failure"; readonly reason: string };

/**
 * Performs one bounded GET, retrying once on a transient failure unless the caller opts out.
 *
 * `retry` is off for existence probes: a listing sweep runs one probe per catalog entry, so a
 * second attempt on every failure doubles the worst-case wait the user sits through for an answer
 * that is only advisory.
 */
export async function getAgenticResource(
  environment: Environment,
  request: HttpGetRequest,
  retry = true,
): Promise<AgenticRequestOutcome> {
  const first = await environment.httpGet(request);
  const result = retry && transient(first) ? await environment.httpGet(request) : first;
  if (result.kind === "failure") {
    return result;
  }
  if (result.status !== 200) {
    return { kind: "failure", reason: `responded with HTTP ${String(result.status)}` };
  }
  return result.kind === "response"
    ? { body: result.body, kind: "text" }
    : { body: result.body, kind: "bytes" };
}

/**
 * Turns one failure reason into a clause naming what the user can do about it.
 *
 * GitHub answers an exhausted anonymous quota with 403 and a burst with 429; both read as an
 * arbitrary refusal unless the message says which one happened and that waiting clears it.
 */
export function agenticRequestFailure(reason: string): string {
  switch (reason) {
    case "response-too-large": {
      return "sent a response larger than Aura reads";
    }
    case "responded with HTTP 403":
    case "responded with HTTP 429": {
      return "was rate-limited by GitHub for this machine; the limit resets within the hour";
    }
    case "timeout": {
      return "did not respond in time";
    }
    default: {
      return reason.startsWith("responded with HTTP ") ? reason : "could not be reached";
    }
  }
}

function transient(result: HttpGetResult): boolean {
  return result.kind === "failure"
    ? result.reason === "network" || result.reason === "timeout"
    : result.status >= 500;
}
