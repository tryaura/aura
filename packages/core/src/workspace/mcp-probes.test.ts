import type { Environment, McpServer } from "@tryaura/aura-sdk";
import { describe, expect, it, vi } from "vitest";

import { createMemoryReader, createTestEnvironment } from "./testing.js";
import { createMcpProber, type McpUrlRequest } from "./mcp-probes.js";

describe("MCP probes", () => {
  it("never invokes the URL requester while offline", async () => {
    const request: McpUrlRequest = () => {
      throw new Error("network access attempted");
    };
    const servers = await prober({ online: false, request })([http("https://example.test/mcp")]);

    expect(servers[0]?.probes).toEqual([
      expect.objectContaining({ kind: "url", status: "unavailable" }),
    ]);
  });

  it("resolves bare and absolute commands without executing them", async () => {
    const environment: Environment = {
      ...createTestEnvironment(),
      pathEntries: ["relative", "/tools", "/tools"],
    };
    const probe = createMcpProber({
      environment,
      online: false,
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

  it("resolves standard Windows executable suffixes", async () => {
    const environment: Environment = {
      ...createTestEnvironment(),
      pathEntries: ["C:\\tools"],
      platform: "win32",
    };
    const servers = await createMcpProber({
      environment,
      online: false,
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
      online: false,
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
    const servers = await prober({ online: true, request })([http("https://example.test/mcp")]);

    expect(calls).toEqual(["HEAD", "GET"]);
    expect(status(servers, "server", "url")).toBe("ok");
  });

  it.each([404, 500, 503])("reports HTTP %s as an error", async (httpStatus) => {
    const servers = await prober({
      online: true,
      request: () => Promise.resolve({ status: httpStatus }),
    })([http("https://example.test/mcp")]);

    expect(status(servers, "server", "url")).toBe("error");
    expect(servers[0]?.probes?.[0]?.detail).toContain(String(httpStatus));
  });

  it("allows three redirects and rejects a fourth", async () => {
    const request: McpUrlRequest = (input) => {
      const step = Number(new URL(input.url).searchParams.get("step") ?? "0");
      return Promise.resolve(
        step < 4 ? { location: `?step=${String(step + 1)}`, status: 302 } : { status: 204 },
      );
    };
    const allowed = await prober({
      online: true,
      request: (input) => {
        const step = Number(new URL(input.url).searchParams.get("step") ?? "0");
        return Promise.resolve(
          step < 3 ? { location: `?step=${String(step + 1)}`, status: 302 } : { status: 204 },
        );
      },
    })([http("https://example.test/mcp?step=0")]);
    const rejected = await prober({ online: true, request })([
      http("https://example.test/mcp?step=0"),
    ]);

    expect(status(allowed, "server", "url")).toBe("ok");
    expect(status(rejected, "server", "url")).toBe("error");
    expect(rejected[0]?.probes?.[0]?.detail).toContain("limit of 3 redirects");
  });

  it("retains bounded TLS failure detail", async () => {
    const cause = new Error("certificate has expired");
    const failure = new Error("fetch failed", { cause });
    const servers = await prober({
      online: true,
      request: () => Promise.reject(failure),
    })([http("https://example.test/mcp")]);

    expect(servers[0]?.probes?.[0]).toMatchObject({
      detail: "fetch failed: certificate has expired",
      kind: "url",
      status: "error",
    });
  });

  it("uses one request sequence for duplicate sanitized URLs", async () => {
    let calls = 0;
    const servers = await prober({
      online: true,
      request: () => {
        calls += 1;
        return Promise.resolve({ status: 204 });
      },
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
    await prober({ online: true, request })(
      Array.from({ length: 12 }, (_, index) =>
        http(`https://example${String(index)}.test/mcp`, `server-${String(index)}`),
      ),
    );

    expect(maximum).toBe(8);
  });

  it("turns the three-second abort into a timeout error", async () => {
    vi.useFakeTimers();
    try {
      const request: McpUrlRequest = (input) =>
        new Promise((_resolve, reject) => {
          input.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      const pending = prober({ online: true, request })([http("https://slow.test/mcp")]);

      await vi.advanceTimersByTimeAsync(3_000);
      const servers = await pending;

      expect(servers[0]?.probes?.[0]).toMatchObject({
        detail: "The URL probe timed out after 3 seconds.",
        status: "error",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

function prober(options: { readonly online: boolean; readonly request: McpUrlRequest }) {
  return createMcpProber({
    environment: createTestEnvironment(),
    online: options.online,
    reader: createMemoryReader(),
    urlRequest: options.request,
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
