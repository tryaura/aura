/**
 * Timeout applied by Aura core when {@link HttpGetRequest.timeoutMs} is omitted.
 *
 * A request is never unbounded: skill-directory fetches run inside the interactive setup flow, so
 * a server that accepts the connection and then stalls would otherwise freeze the wizard.
 */
export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

/**
 * Upper bound Aura core clamps {@link HttpGetRequest.timeoutMs} to.
 *
 * A caller cannot opt out of the ceiling by requesting a larger value.
 */
export const MAX_HTTP_TIMEOUT_MS = 60_000;

/**
 * Bytes Aura core reads from a response body before abandoning the request as too large.
 *
 * Responses are buffered in memory, so an unbounded body would exhaust the heap. Callers may lower
 * the cap per request via {@link HttpGetRequest.maxResponseBytes} but never raise it.
 */
export const MAX_HTTP_RESPONSE_BYTES = 8_000_000;

/**
 * A request for one HTTPS resource.
 *
 * Aura core refuses plain `http:` URLs except for the literal loopback hosts `127.0.0.1` and
 * `[::1]`, so a credential-bearing request cannot leave the machine unencrypted. Redirects are
 * refused outright rather than followed: a redirect would re-send the headers, credentials
 * included, to an address the caller never named.
 */
export interface HttpGetRequest {
  /**
   * Headers sent verbatim.
   *
   * May carry credentials, which is why {@link HttpGetResult} deliberately cannot echo the request
   * back. Build header values at the call site and never copy them anywhere that outlives the
   * call.
   */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /**
   * Response cap in bytes.
   *
   * Defaults to {@link MAX_HTTP_RESPONSE_BYTES} and is clamped to it. A value that is zero,
   * negative, or not finite is replaced by the default.
   */
  readonly maxResponseBytes?: number | undefined;
  /**
   * Milliseconds before the request is aborted.
   *
   * Defaults to {@link DEFAULT_HTTP_TIMEOUT_MS} and is clamped to {@link MAX_HTTP_TIMEOUT_MS}. A
   * value that is zero, negative, or not finite is replaced by the default: there is no way to
   * request an unbounded fetch.
   */
  readonly timeoutMs?: number | undefined;
  /** Absolute URL of the resource. See the interface doc for the `https:` requirement. */
  readonly url: string;
}

/**
 * Why a request produced no response.
 *
 * Reasons are a closed vocabulary rather than error text so no server- or runtime-supplied string
 * — which could embed a credential from the request — ever travels with the result.
 */
export type HttpFailureReason =
  /** The URL is not `https:` and not a literal loopback host. Enforced here, not by callers. */
  | "insecure-url"
  /** The URL did not parse as an absolute URL. */
  | "invalid-url"
  /** DNS, TLS, connection, or read failure — including a refused redirect. */
  | "network"
  /** The body exceeded {@link HttpGetRequest.maxResponseBytes}. */
  | "response-too-large"
  /** The request exceeded {@link HttpGetRequest.timeoutMs}. */
  | "timeout";

/**
 * The outcome of an {@link HttpGetRequest}. Resolves for every outcome and never rejects.
 *
 * The shape carries no request echo — no URL, no headers — so a credential placed in a request
 * header structurally cannot flow into diagnostics or logs through the result.
 */
export type HttpGetResult =
  | { readonly kind: "failure"; readonly reason: HttpFailureReason }
  | {
      /** Response body decoded as UTF-8, complete and within the byte cap. */
      readonly body: string;
      readonly kind: "response";
      /** HTTP status code as received; a non-2xx status is a response, not a failure. */
      readonly status: number;
    };
