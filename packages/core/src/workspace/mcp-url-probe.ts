import { hasMcpRedaction, type McpProbeResult } from "@tryaura/aura-sdk";

import type { McpUrlRequest, McpUrlRequestInput, McpUrlResponse } from "./mcp-url-request.js";
import { isPrivateHostname } from "./private-address.js";

const MAX_CAUSE_DEPTH = 8;
const MAX_DETAIL_CHARACTERS = 300;
const MAX_REDIRECTS = 3;
const URL_PROBE_TIMEOUT_MS = 3_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Asks one remote MCP endpoint whether it answers, without authenticating and without a body.
 *
 * Two things are deliberately not errors. A URL Aura redacted addresses somewhere the user did not
 * configure, so probing it would report on the wrong endpoint; and a redirect Aura declines to
 * follow is Aura's limit, not the server's fault. Both come back `unsupported`, which no check
 * gates on.
 */
export async function probeMcpUrl(
  url: string,
  request: McpUrlRequest | undefined,
): Promise<McpProbeResult> {
  if (hasMcpRedaction(url)) {
    return {
      detail:
        "URL reachability was not checked because this endpoint carries credentials that Aura removed before the URL entered the model.",
      kind: "url",
      status: "unsupported",
    };
  }
  if (request === undefined) {
    return {
      detail: "URL reachability was not checked because online probing was not enabled.",
      kind: "url",
      status: "unavailable",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), URL_PROBE_TIMEOUT_MS);
  try {
    return await runProbe(url, controller.signal, request);
  } catch (error) {
    return controller.signal.aborted
      ? {
          detail: "The URL probe timed out after 3 seconds.",
          kind: "url",
          status: "error",
          transient: true,
        }
      : { detail: boundedDetail(error), kind: "url", status: "error" };
  } finally {
    clearTimeout(timeout);
  }
}

async function runProbe(
  url: string,
  signal: AbortSignal,
  request: McpUrlRequest,
): Promise<McpProbeResult> {
  const redirects = { count: 0 };
  const head = await follow(url, "HEAD", signal, redirects, request);
  if (head.kind !== "response") {
    return outcomeProblem(head);
  }
  // A server that refuses HEAD says nothing about whether it is there.
  if (head.response.status !== 405) {
    return responseProblem(head.response.status);
  }

  const get = await follow(head.url, "GET", signal, redirects, request);
  return get.kind === "response" ? responseProblem(get.response.status) : outcomeProblem(get);
}

type FollowOutcome =
  | { readonly kind: "failed"; readonly detail: string }
  | { readonly kind: "refused"; readonly detail: string }
  | { readonly kind: "response"; readonly response: McpUrlResponse; readonly url: string };

async function follow(
  initialUrl: string,
  method: McpUrlRequestInput["method"],
  signal: AbortSignal,
  redirects: { count: number },
  request: McpUrlRequest,
): Promise<FollowOutcome> {
  let url = initialUrl;
  while (true) {
    const response = await request({ method, signal, url });
    if (!REDIRECT_STATUSES.has(response.status)) {
      return { kind: "response", response, url };
    }
    if (redirects.count >= MAX_REDIRECTS) {
      return { detail: "The URL exceeded Aura's limit of 3 redirects.", kind: "failed" };
    }
    if (response.location === undefined) {
      return {
        detail: `The URL returned redirect status ${String(response.status)} without a location.`,
        kind: "failed",
      };
    }
    const target = redirectTarget(response.location, url);
    if (typeof target === "string") {
      return { detail: target, kind: "refused" };
    }
    redirects.count += 1;
    url = target.toString();
  }
}

/** The next URL to request, or the reason Aura will not request it. */
function redirectTarget(location: string, base: string): URL | string {
  let target: URL;
  try {
    target = new URL(location, base);
  } catch {
    return `The URL redirected to a location Aura could not resolve.`;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return `The URL redirected to ${target.protocol}, which Aura does not probe.`;
  }
  return isPrivateHostname(target.hostname)
    ? `The URL redirected to ${target.hostname}, a private address Aura does not follow.`
    : target;
}

function outcomeProblem(outcome: Exclude<FollowOutcome, { kind: "response" }>): McpProbeResult {
  return outcome.kind === "refused"
    ? { detail: outcome.detail, kind: "url", status: "unsupported" }
    : { detail: outcome.detail, kind: "url", status: "error" };
}

/**
 * Reads one status code.
 *
 * An authentication challenge is a server answering, and Aura sends no credentials on purpose. A
 * fault the server reports about itself is an error a re-run may not repeat, so it is transient;
 * a missing endpoint is not.
 */
function responseProblem(status: number): McpProbeResult {
  if (status >= 500) {
    return {
      detail: `The URL responded with HTTP ${String(status)}.`,
      kind: "url",
      status: "error",
      transient: true,
    };
  }
  return status === 404
    ? { detail: "The URL responded with HTTP 404.", kind: "url", status: "error" }
    : { kind: "url", status: "ok" };
}

function boundedDetail(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  // A cause chain is arbitrary input: it can repeat, and it can point back at itself.
  while (current instanceof Error && !seen.has(current) && seen.size < MAX_CAUSE_DEPTH) {
    seen.add(current);
    if (current.message !== "" && !messages.includes(current.message)) {
      messages.push(current.message);
    }
    current = "cause" in current ? current.cause : undefined;
  }
  const detail = messages.length === 0 ? String(error) : messages.join(": ");
  return detail.length <= MAX_DETAIL_CHARACTERS
    ? detail
    : `${detail.slice(0, MAX_DETAIL_CHARACTERS)}…`;
}
