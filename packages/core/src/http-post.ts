import type { HttpPostRequest, HttpPostResult } from "@tryaura/aura-sdk";

import { clampHttpTimeout, failureReason, vetHttpUrl } from "./http.js";

/**
 * Creates a bounded, TLS-only JSON POST that never rejects.
 *
 * The delivery-side sibling of {@link createHttpGet}, holding to the same discipline: plain
 * `http:` is refused except for literal loopback hosts, redirects are refused (`redirect:
 * "error"`) so headers are never re-sent to an address the caller did not name, and every throw
 * collapses into the closed failure vocabulary with no request echo. The response body is
 * discarded unread — a delivery needs only the status code.
 */
export function createHttpPost(): (request: HttpPostRequest) => Promise<HttpPostResult> {
  return async (request) => {
    const vetted = vetHttpUrl(request.url);
    if (!(vetted instanceof URL)) {
      return { kind: "failure", reason: vetted };
    }

    try {
      const headers = new Headers(request.headers);
      headers.set("content-type", "application/json");
      const response = await fetch(vetted, {
        body: request.body,
        headers,
        method: "POST",
        redirect: "error",
        signal: postSignal(request),
      });
      await response.body?.cancel();
      return { kind: "response", status: response.status };
    } catch (error) {
      return { kind: "failure", reason: failureReason(error) };
    }
  };
}

/** Combines caller cancellation with the transport's non-negotiable timeout. */
function postSignal(request: HttpPostRequest): AbortSignal {
  const timeout = AbortSignal.timeout(clampHttpTimeout(request.timeoutMs));
  return request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]);
}
