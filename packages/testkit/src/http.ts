import type { Environment } from "@tryaura/aura-sdk";
import { createHttpGet } from "@tryaura/core";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);

const realHttpGet = createHttpGet();

/**
 * The network policy every testkit runner injects: loopback servers only.
 *
 * A test run is hermetic by construction — a distribution that registers a real skill directory
 * must not make its integration tests reach that host. Mock servers listen on `127.0.0.1`, which
 * this passes straight through to the kernel's own client, caps and all.
 */
export const loopbackOnlyHttpGet: Environment["httpGet"] = (request) => {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return Promise.resolve({ kind: "failure", reason: "invalid-url" });
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    return Promise.resolve({ kind: "failure", reason: "network" });
  }
  return realHttpGet(request);
};
