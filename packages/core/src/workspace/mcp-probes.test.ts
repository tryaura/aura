import type { Environment, McpServer } from "@tryaura/aura-sdk";
import { describe, expect, it, vi } from "vitest";

import { createMemoryReader, createTestEnvironment, DIRECTORY } from "./testing.js";
import { createMcpProber } from "./mcp-probes.js";
import type { McpUrlRequest } from "./mcp-url-request.js";

describe("MCP probes", () => {
  it("never invokes the URL requester while offline", async () => {
    const servers = await createMcpProber({
      environment: createTestEnvironment(),
      reader: createMemoryReader(),
    })([http("https://example.test/mcp")]);

    expect(servers[0]?.probes).toEqual([
      expect.objectContaining({ kind: "url", status: "unavailable" }),
    ]);
  });

  it("leaves a redacted endpoint unprobed rather than checking the wrong URL", async () => {
    const request: McpUrlRequest = () => {
      throw new Error("network access attempted");
    };
    const servers = await prober(request)([http("https://example.test/mcp?workspace=[redacted]")]);

    expect(servers[0]?.probes?.[0]).toMatchObject({ kind: "url", status: "unsupported" });
    expect(servers[0]?.probes?.[0]?.detail).toContain("credentials");
  });

  it("resolves bare and absolute commands without executing them", async () => {
    const environment: Environment = {
      ...createTestEnvironment(),
      pathEntries: ["relative", "/tools", "/tools"],
    };
    const probe = createMcpProber({
      environment,
      reader: createMemoryReader({ "/absolute/server": "", "/tools/present": "" }),
    });
    const servers = await probe([
      stdio("present", "present"),
      stdio("missing", "missing"),
      stdio("", "empty"),
      stdio("/absolute/server", "absolute"),
      stdio("./relative-server", "relative"),
    ]);

    expect(status(servers, "present", "command")).toBe("ok");
    expect(status(servers, "missing", "command")).toBe("error");
    expect(status(servers, "empty", "command")).toBe("error");
    expect(status(servers, "absolute", "command")).toBe("ok");
    expect(status(servers, "relative", "command")).toBe("unsupported");
  });

  it("rejects a directory and a dangling symlink on the search path", async () => {
    const environment: Environment = {
      ...createTestEnvironment(),
      pathEntries: ["/tools"],
    };
    const reader = createMemoryReader(
      { "/tools/directory": DIRECTORY },
      { links: { "/tools/dangling": "/tools/gone" } },
    );
    const servers = await createMcpProber({ environment, reader })([
      stdio("directory", "directory"),
      stdio("dangling", "dangling"),
    ]);

    expect(status(servers, "directory", "command")).toBe("error");
    expect(status(servers, "dangling", "command")).toBe("error");
  });

  it("resolves standard Windows executable suffixes", async () => {
    const environment: Environment = {
      ...createTestEnvironment(),
      pathEntries: ["C:\\tools"],
      platform: "win32",
    };
    const servers = await createMcpProber({
      environment,
      reader: createMemoryReader({ "C:\\tools\\runner.cmd": "" }),
    })([stdio("runner")]);

    expect(status(servers, "server", "command")).toBe("ok");
  });

  it("checks package runners but leaves package availability unknown", async () => {
    const environment: Environment = {
      ...createTestEnvironment(),
      pathEntries: ["/tools"],
    };
    const servers = await createMcpProber({
      environment,
      reader: createMemoryReader({ "/tools/npx": "" }),
    })([stdio("npx", "found"), stdio("uvx", "missing")]);

    expect(status(servers, "found", "command")).toBe("ok");
    expect(status(servers, "found", "package")).toBe("unknown");
    expect(status(servers, "missing", "command")).toBe("error");
    expect(status(servers, "missing", "package")).toBe("unavailable");
  });

  it("falls back from HEAD to GET and accepts authentication responses", async () => {
    const calls: string[] = [];
    const request: McpUrlRequest = (input) => {
      calls.push(input.method);
      return Promise.resolve({ status: input.method === "HEAD" ? 405 : 401 });
    };
    const servers = await prober(request)([http("https://example.test/mcp")]);

    expect(calls).toEqual(["HEAD", "GET"]);
    expect(status(servers, "server", "url")).toBe("ok");
  });

  it("reports a missing endpoint as an error a re-run will repeat", async () => {
    const servers = await prober(() => Promise.resolve({ status: 404 }))([
      http("https://example.test/mcp"),
    ]);

    expect(servers[0]?.probes?.[0]).toEqual({
      detail: "The URL responded with HTTP 404.",
      kind: "url",
      status: "error",
    });
  });

  it.each([500, 503])("reports HTTP %s as a transient error", async (httpStatus) => {
    const servers = await prober(() => Promise.resolve({ status: httpStatus }))([
      http("https://example.test/mcp"),
    ]);

    expect(servers[0]?.probes?.[0]).toMatchObject({ status: "error", transient: true });
    expect(servers[0]?.probes?.[0]?.detail).toContain(String(httpStatus));
  });

  it("allows three redirects and rejects a fourth", async () => {
    const steps = (limit: number): McpUrlRequest => {
      return (input) => {
        const step = Number(new URL(input.url).searchParams.get("step") ?? "0");
        return Promise.resolve(
          step < limit ? { location: `?step=${String(step + 1)}`, status: 302 } : { status: 204 },
        );
      };
    };
    const allowed = await prober(steps(3))([http("https://example.test/mcp?step=0")]);
    const rejected = await prober(steps(4))([http("https://example.test/mcp?step=0")]);

    expect(status(allowed, "server", "url")).toBe("ok");
    expect(status(rejected, "server", "url")).toBe("error");
    expect(rejected[0]?.probes?.[0]?.detail).toContain("limit of 3 redirects");
  });

  it.each([
    ["http://169.254.169.254/latest/meta-data/", "169.254.169.254"],
    ["http://localhost:8080/mcp", "localhost"],
    ["http://[::1]:8080/mcp", "::1"],
    ["file:///etc/passwd", "file:"],
  ])("refuses to follow a redirect to %s", async (location, mentioned) => {
    const calls: string[] = [];
    const request: McpUrlRequest = (input) => {
      calls.push(input.url);
      return Promise.resolve({ location, status: 302 });
    };
    const servers = await prober(request)([http("https://example.test/mcp")]);

    expect(calls).toEqual(["https://example.test/mcp"]);
    expect(servers[0]?.probes?.[0]).toMatchObject({ kind: "url", status: "unsupported" });
    expect(servers[0]?.probes?.[0]?.detail).toContain(mentioned);
  });

  it("still probes a private address the user configured directly", async () => {
    const servers = await prober(() => Promise.resolve({ status: 204 }))([
      http("http://127.0.0.1:3000/mcp"),
    ]);

    expect(status(servers, "server", "url")).toBe("ok");
  });

  it("retains bounded TLS failure detail", async () => {
    const cause = new Error("certificate has expired");
    const failure = new Error("fetch failed", { cause });
    const servers = await prober(() => Promise.reject(failure))([http("https://example.test/mcp")]);

    expect(servers[0]?.probes?.[0]).toMatchObject({
      detail: "fetch failed: certificate has expired",
      kind: "url",
      status: "error",
    });
  });

  it("terminates on a cyclic error cause", async () => {
    const failure: Error & { cause?: unknown } = new Error("fetch failed");
    failure.cause = failure;
    const servers = await prober(() => Promise.reject(failure))([http("https://example.test/mcp")]);

    expect(servers[0]?.probes?.[0]?.detail).toBe("fetch failed");
  });

  it("uses one request sequence for duplicate sanitized URLs", async () => {
    let calls = 0;
    const servers = await prober(() => {
      calls += 1;
      return Promise.resolve({ status: 204 });
    })([http("https://example.test/mcp", "one"), http("https://example.test/mcp", "two")]);

    expect(calls).toBe(1);
    expect(servers.map((server) => server.probes?.[0]?.status)).toEqual(["ok", "ok"]);
  });

  it("caps concurrent URL requests at eight", async () => {
    let active = 0;
    let maximum = 0;
    const request: McpUrlRequest = async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { status: 204 };
    };
    await prober(request)(
      Array.from({ length: 12 }, (_, index) =>
        http(`https://example${String(index)}.test/mcp`, `server-${String(index)}`),
      ),
    );

    expect(maximum).toBe(8);
  });

  it("turns the three-second abort into a transient timeout", async () => {
    vi.useFakeTimers();
    try {
      const request: McpUrlRequest = (input) =>
        new Promise((_resolve, reject) => {
          input.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      const pending = prober(request)([http("https://slow.test/mcp")]);

      await vi.advanceTimersByTimeAsync(3_000);
      const servers = await pending;

      expect(servers[0]?.probes?.[0]).toMatchObject({
        detail: "The URL probe timed out after 3 seconds.",
        status: "error",
        transient: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

function prober(request: McpUrlRequest) {
  return createMcpProber({
    environment: createTestEnvironment(),
    reader: createMemoryReader(),
    urlRequest: request,
  });
}

function stdio(command: string, name = "server"): McpServer {
  return {
    appId: "fake",
    name,
    scope: "global",
    sourceId: "fake.mcp.global",
    transport: { command, type: "stdio" },
  };
}

function http(url: string, name = "server"): McpServer {
  return {
    appId: "fake",
    name,
    scope: "global",
    sourceId: "fake.mcp.global",
    transport: { type: "http", url },
  };
}

function status(
  servers: readonly McpServer[],
  name: string,
  kind: "command" | "package" | "url",
): string | undefined {
  return servers
    .find((server) => server.name === name)
    ?.probes?.find((probe) => probe.kind === kind)?.status;
}
