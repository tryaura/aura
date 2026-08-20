import type { DirectorySkillSource, Environment, HttpGetResult } from "@tryaura/aura-sdk";

import { isAllowedHttpUrl } from "../http.boundary.js";

export type RequestOutcome =
  | { readonly kind: "failure"; readonly reason: string }
  | { readonly kind: "missing-token"; readonly variable: string }
  | {
      readonly body: string;
      readonly etag?: string | undefined;
      readonly kind: "response";
      readonly status: number;
    };

/**
 * Performs one authenticated GET against the directory, retrying exactly once on a transient
 * failure. The token is read here, at request time, into a call-local header object; it exists
 * nowhere else and outlives nothing.
 *
 * `ifNoneMatch` turns the GET conditional: a 304 comes back as a plain response for the caller
 * holding the cached body to recognize.
 */
export async function request(
  environment: Environment,
  source: DirectorySkillSource,
  path: string,
  maxResponseBytes: number,
  ifNoneMatch?: string,
): Promise<RequestOutcome> {
  const endpoint = directoryEndpoint(source.url, path);
  if (endpoint.kind === "failure") {
    return endpoint;
  }

  const headers: Record<string, string> = {};
  const variable = tokenVariable(source);
  if (variable !== undefined) {
    const token = environment.readVariable(variable);
    if (token === undefined) {
      return { kind: "missing-token", variable };
    }
    headers["Authorization"] = `Bearer ${token}`;
  }
  if (ifNoneMatch !== undefined) {
    headers["If-None-Match"] = ifNoneMatch;
  }

  const first = await environment.httpGet({ headers, maxResponseBytes, url: endpoint.url });
  const result = isTransient(first)
    ? await environment.httpGet({ headers, maxResponseBytes, url: endpoint.url })
    : first;
  if (result.kind === "failure") {
    return { kind: "failure", reason: result.reason };
  }
  if (result.kind !== "response") {
    return { kind: "failure", reason: "network" };
  }
  return {
    body: result.body,
    ...(result.etag === undefined ? {} : { etag: result.etag }),
    kind: "response",
    status: result.status,
  };
}

export type DirectoryEndpoint =
  | { readonly kind: "failure"; readonly reason: "insecure-url" | "invalid-url" }
  | { readonly kind: "url"; readonly url: string };

/** Resolves one protocol path below a normalized directory base URL. */
export function directoryEndpoint(baseUrl: string, path: string): DirectoryEndpoint {
  try {
    const base = new URL(baseUrl);
    if (!isAllowedHttpUrl(base)) {
      return { kind: "failure", reason: "insecure-url" };
    }
    if (base.username !== "" || base.password !== "" || base.search !== "" || base.hash !== "") {
      return { kind: "failure", reason: "invalid-url" };
    }
    base.pathname = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
    return { kind: "url", url: new URL(path, base).href };
  } catch {
    return { kind: "failure", reason: "invalid-url" };
  }
}

/** A failed request or a 5xx answer may be a blip; anything else would fail identically again. */
function isTransient(result: HttpGetResult): boolean {
  if (result.kind === "failure") {
    return result.reason === "network" || result.reason === "timeout";
  }
  return result.status >= 500;
}

function tokenVariable(source: DirectorySkillSource): string | undefined {
  return source.kind === "private-directory" ? source.tokenEnv : undefined;
}

export function failureReasonText(reason: string): string {
  switch (reason) {
    case "insecure-url": {
      return "has a URL that is not https";
    }
    case "invalid-url": {
      return "has a URL that does not parse";
    }
    case "response-too-large": {
      return "sent a response larger than Aura reads";
    }
    case "timeout": {
      return "did not respond in time";
    }
    default: {
      return "could not be reached";
    }
  }
}

export function failureHint(reason: string): string {
  switch (reason) {
    case "insecure-url":
    case "invalid-url": {
      return "fix the directory URL";
    }
    case "response-too-large": {
      return "index too large";
    }
    case "timeout": {
      return "timed out";
    }
    default: {
      return "unreachable";
    }
  }
}

export function statusReasonText(source: DirectorySkillSource, status: number): string {
  const variable = tokenVariable(source);
  if ((status === 401 || status === 403) && variable !== undefined) {
    return `rejected the token from ${variable}`;
  }
  return `responded with HTTP ${String(status)}`;
}

export function statusHint(source: DirectorySkillSource, status: number): string {
  const variable = tokenVariable(source);
  if ((status === 401 || status === 403) && variable !== undefined) {
    return `check ${variable}`;
  }
  return `HTTP ${String(status)}`;
}
