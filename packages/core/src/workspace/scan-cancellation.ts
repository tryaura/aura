import type { Environment, ExecRequest } from "@tryaura/aura-sdk";

/** Injects one scan's cancellation into every command an adapter starts. */
export function withScanCancellation(
  environment: Environment,
  signal: AbortSignal | undefined,
): Environment {
  if (signal === undefined) {
    return environment;
  }
  return Object.freeze({
    ...environment,
    exec: async (request: ExecRequest) => {
      signal.throwIfAborted();
      const result = await environment.exec({
        ...request,
        signal: request.signal === undefined ? signal : AbortSignal.any([request.signal, signal]),
      });
      signal.throwIfAborted();
      return result;
    },
  });
}
