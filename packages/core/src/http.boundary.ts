import type { HttpGetRequest, HttpGetResult } from "@tryaura/aura-sdk";
import {
  DEFAULT_HTTP_TIMEOUT_MS,
  MAX_HTTP_RESPONSE_BYTES,
  MAX_HTTP_TIMEOUT_MS,
} from "@tryaura/aura-sdk";

/**
 * Hosts allowed to serve plain `http:`.
 *
 * Literal loopback addresses only: `localhost` can resolve anywhere the resolver decides, so a
 * credential sent to it could still leave the machine.
 */
const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "[::1]"];

/**
 * Creates {@link Environment.httpGet}: a bounded, TLS-only GET that never rejects.
 *
 * Redirects are refused (`redirect: "error"`) so a directory cannot bounce a bearer token to an
 * address the caller never named. The response body is streamed against the byte cap rather than
 * buffered first, so an oversized body is abandoned mid-transfer.
 */
export function createHttpGet(): (request: HttpGetRequest) => Promise<HttpGetResult> {
  return async (request) => {
    const vetted = vetHttpUrl(request.url);
    if (!(vetted instanceof URL)) {
      return { kind: "failure", reason: vetted };
    }

    const maxBytes = clamp(
      request.maxResponseBytes,
      MAX_HTTP_RESPONSE_BYTES,
      MAX_HTTP_RESPONSE_BYTES,
    );

    try {
      const response = await fetch(vetted, {
        headers: request.headers ?? {},
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(clampHttpTimeout(request.timeoutMs)),
      });
      return await readBody(response, maxBytes, request.responseType === "bytes");
    } catch (error) {
      return { kind: "failure", reason: failureReason(error) };
    }
  };
}

/** Parses a URL and applies the TLS-only rule, collapsing both refusals into failure reasons. */
export function vetHttpUrl(raw: string): URL | "insecure-url" | "invalid-url" {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "invalid-url";
  }
  return isAllowedHttpUrl(url) ? url : "insecure-url";
}

/** Applies the shared timeout default and ceiling every HTTP client in the kernel honors. */
export function clampHttpTimeout(value: number | undefined): number {
  return clamp(value, DEFAULT_HTTP_TIMEOUT_MS, MAX_HTTP_TIMEOUT_MS);
}

/** Replaces an absent, zero, negative, or non-finite value by the default; caps at the ceiling. */
function clamp(value: number | undefined, fallback: number, ceiling: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(value, ceiling);
}

function isLoopbackHttp(url: URL): boolean {
  return url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname);
}

/**
 * Whether a parsed URL satisfies the TLS rule {@link createHttpGet} enforces.
 *
 * Exposed so configuration that carries a URL — a registered skill directory, a preset entry — can
 * be refused at validation time with a named problem instead of failing later mid-request.
 */
export function isAllowedHttpUrl(url: URL): boolean {
  return url.protocol === "https:" || isLoopbackHttp(url);
}

/** Streams the body against the byte cap; decoding happens only once the cap is known to hold. */
async function readBody(
  response: Response,
  maxBytes: number,
  binary: boolean,
): Promise<HttpGetResult> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return binary
      ? { body: new Uint8Array(), kind: "binary-response", status: response.status }
      : { body: "", kind: "response", status: response.status };
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      return { kind: "failure", reason: "response-too-large" };
    }
    chunks.push(value);
  }

  const body = concatenate(chunks, received);
  return binary
    ? { body, kind: "binary-response", status: response.status }
    : { body: new TextDecoder().decode(body), kind: "response", status: response.status };
}

function concatenate(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

/**
 * Collapses every throw into the closed failure vocabulary.
 *
 * Error text is deliberately dropped: runtime messages can echo the request, and the request may
 * carry credentials in its headers.
 */
export function failureReason(error: unknown): "network" | "timeout" {
  const name = error instanceof Error ? error.name : "";
  return name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
}
