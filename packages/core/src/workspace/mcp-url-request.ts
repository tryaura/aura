import { EnvHttpProxyAgent, fetch } from "undici";

export interface McpUrlRequestInput {
  readonly method: "GET" | "HEAD";
  readonly signal: AbortSignal;
  readonly url: string;
}

export interface McpUrlResponse {
  readonly location?: string | undefined;
  readonly status: number;
}

/** Injectable transport seam used to make online probing deterministic in tests and embedders. */
export type McpUrlRequest = (input: McpUrlRequestInput) => Promise<McpUrlResponse>;

/** A requester and the pooled connections it holds open. */
export interface McpUrlRequester {
  /** Releases pooled sockets. Without it the process waits out undici's keep-alive before exiting. */
  readonly close: () => Promise<void>;
  readonly request: McpUrlRequest;
}

/**
 * Builds a proxy-aware requester from the same captured environment snapshot the CLI uses.
 *
 * One dispatcher serves every probe: building one per request would pay a fresh proxy and TLS
 * handshake on each redirect hop, inside a budget measured in seconds.
 */
export function createMcpUrlRequester(
  environmentVariables: Readonly<Record<string, string | undefined>>,
): McpUrlRequester {
  // Every proxy key is passed, including the ones the snapshot does not carry: undici falls back
  // to `process.env` for an *omitted* option, which would route probes through a proxy that the
  // captured environment never mentioned. An empty string pins the option and reads as "none".
  const dispatcher = new EnvHttpProxyAgent({
    httpProxy: environmentValue(environmentVariables, "http_proxy") ?? "",
    httpsProxy: environmentValue(environmentVariables, "https_proxy") ?? "",
    noProxy: environmentValue(environmentVariables, "no_proxy") ?? "",
  });

  return {
    close: () => dispatcher.close(),
    request: async (input): Promise<McpUrlResponse> => {
      const response = await fetch(input.url, {
        dispatcher,
        method: input.method,
        redirect: "manual",
        signal: input.signal,
      });
      const location = response.headers.get("location") ?? undefined;
      await response.body?.cancel();
      return { ...(location === undefined ? {} : { location }), status: response.status };
    },
  };
}

/** Reads one proxy variable in undici's own precedence, so both agree on which case wins. */
function environmentValue(
  variables: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  return variables[name] ?? variables[name.toUpperCase()];
}
