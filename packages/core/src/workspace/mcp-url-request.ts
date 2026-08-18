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

/** Builds a proxy-aware requester from the same captured environment snapshot the CLI uses. */
export function createMcpUrlRequest(
  environmentVariables: Readonly<Record<string, string | undefined>>,
): McpUrlRequest {
  const httpProxy = environmentValue(environmentVariables, "HTTP_PROXY");
  const httpsProxy = environmentValue(environmentVariables, "HTTPS_PROXY");
  const noProxy = environmentValue(environmentVariables, "NO_PROXY");
  const proxyOptions = {
    ...(httpProxy === undefined ? {} : { httpProxy }),
    ...(httpsProxy === undefined ? {} : { httpsProxy }),
    ...(noProxy === undefined ? {} : { noProxy }),
  };

  return async (input): Promise<McpUrlResponse> => {
    const dispatcher = new EnvHttpProxyAgent(proxyOptions);
    try {
      const response = await fetch(input.url, {
        dispatcher,
        method: input.method,
        redirect: "manual",
        signal: input.signal,
      });
      const location = response.headers.get("location") ?? undefined;
      await response.body?.cancel();
      return { ...(location === undefined ? {} : { location }), status: response.status };
    } finally {
      await dispatcher.close();
    }
  };
}

function environmentValue(
  variables: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const key = Object.keys(variables).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : variables[key];
}
