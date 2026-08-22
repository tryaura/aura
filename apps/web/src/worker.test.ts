import type { CommandFailedEvent, TelemetryBatchV1, TelemetryEvent } from "@tryaura/aura-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  handleRequest,
  persistEvents,
  type TelemetryAssets,
  type TelemetryDatabase,
  type TelemetryExecutionContext,
  type TelemetryRateLimiter,
  type TelemetryStatement,
  type TelemetryWorkerEnvironment,
} from "./worker.js";

const ENDPOINT = "https://tryaura.sh/api/telemetry/v1";
const AT = "2026-08-22T12:34:56.000Z";
const FAILED_EVENT: CommandFailedEvent = {
  at: AT,
  command: "check",
  distroVersion: "1.2.3",
  exitCode: 3,
  kind: "command-failed",
};

type DatabaseValue = string | number | null;

class FakeStatement implements TelemetryStatement {
  values: readonly DatabaseValue[] = [];

  bind(...values: readonly DatabaseValue[]): TelemetryStatement {
    this.values = values;
    return this;
  }
}

class FakeDatabase implements TelemetryDatabase {
  readonly prepared: FakeStatement[] = [];
  batchCount = 0;

  constructor(private readonly failure: Error | undefined = undefined) {}

  batch(_statements: readonly TelemetryStatement[]): Promise<unknown> {
    this.batchCount += 1;
    return this.failure === undefined ? Promise.resolve([]) : Promise.reject(this.failure);
  }

  prepare(_query: string): TelemetryStatement {
    const statement = new FakeStatement();
    this.prepared.push(statement);
    return statement;
  }
}

class FakeRateLimiter implements TelemetryRateLimiter {
  readonly keys: string[] = [];

  constructor(private readonly success = true) {}

  limit(options: { readonly key: string }): Promise<{ readonly success: boolean }> {
    this.keys.push(options.key);
    return Promise.resolve({ success: this.success });
  }
}

class FakeAssets implements TelemetryAssets {
  readonly paths: string[] = [];

  fetch(request: Request): Promise<Response> {
    this.paths.push(new URL(request.url).pathname);
    return Promise.resolve(new Response("asset", { status: 200 }));
  }
}

class FakeContext implements TelemetryExecutionContext {
  readonly pending: Promise<unknown>[] = [];

  waitUntil(promise: Promise<unknown>): void {
    this.pending.push(promise);
  }

  async settle(): Promise<void> {
    await Promise.all(this.pending);
  }
}

interface Fixture {
  readonly assets: FakeAssets;
  readonly context: FakeContext;
  readonly database: FakeDatabase;
  readonly environment: TelemetryWorkerEnvironment;
  readonly limiter: FakeRateLimiter;
}

interface TestBatch {
  readonly events: readonly unknown[];
  readonly kind: string;
  readonly schemaVersion: number;
}

function fixture(
  options: { readonly databaseFailure?: Error; readonly rateAllowed?: boolean } = {},
): Fixture {
  const assets = new FakeAssets();
  const context = new FakeContext();
  const database = new FakeDatabase(options.databaseFailure);
  const limiter = new FakeRateLimiter(options.rateAllowed);
  return {
    assets,
    context,
    database,
    environment: {
      ASSETS: assets,
      TELEMETRY_DB: database,
      TELEMETRY_RATE_LIMIT: limiter,
    },
    limiter,
  };
}

function batch(events: readonly unknown[] = [FAILED_EVENT]): TestBatch {
  return { events, kind: "aura-telemetry", schemaVersion: 1 };
}

function post(
  body: unknown,
  options: { readonly headers?: Readonly<Record<string, string>>; readonly url?: string } = {},
): Request {
  return new Request(options.url ?? ENDPOINT, {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...options.headers },
    method: "POST",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("telemetry Worker", () => {
  it("accepts, rate limits, and persists a valid batch without storing request metadata", async () => {
    const test = fixture();
    const request = post(batch(), { headers: { "cf-connecting-ip": "192.0.2.1" } });

    const response = await handleRequest(request, test.environment, test.context);
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(test.limiter.keys).toEqual(["192.0.2.1"]);
    expect(test.context.pending).toHaveLength(1);

    await test.context.settle();
    expect(test.database.batchCount).toBe(1);
    expect(test.database.prepared).toHaveLength(1);
    expect(test.database.prepared[0]?.values).toEqual([
      AT,
      1,
      "command-failed",
      "check",
      "1.2.3",
      3,
      null,
      JSON.stringify(FAILED_EVENT),
    ]);
  });

  it("projects duration only for event variants that define it", async () => {
    const database = new FakeDatabase();
    const check: TelemetryEvent = {
      apps: [],
      at: AT,
      checks: [],
      command: "check",
      counts: { errors: 0, informational: 0, passed: 0, warnings: 0 },
      diagnosticCount: 0,
      durationMs: 17.5,
      exitCode: 0,
      flags: {
        dryRun: false,
        fix: false,
        interactive: false,
        json: true,
        online: false,
        verbose: false,
      },
      kind: "check-run",
    };
    const validBatch: TelemetryBatchV1 = {
      events: [check, FAILED_EVENT],
      kind: "aura-telemetry",
      schemaVersion: 1,
    };

    await persistEvents(database, validBatch);
    expect(database.prepared[0]?.values[6]).toBe(17.5);
    expect(database.prepared[1]?.values[6]).toBeNull();
  });

  it.each([
    ["invalid JSON", post("{"), 400],
    ["invalid schema", post({ ...batch(), extra: true }), 400],
    ["wrong content type", post(batch(), { headers: { "content-type": "text/plain" } }), 415],
    ["too many events", post(batch(Array.from({ length: 6 }, () => FAILED_EVENT))), 413],
    ["empty batch", post(batch([])), 400],
    [
      "non-release version",
      post(batch([{ ...FAILED_EVENT, distroVersion: "private workstation" }])),
      400,
    ],
    [
      "non-official identifier",
      post(
        batch([
          {
            apps: [{ appId: "/Users/private", installed: true }],
            at: AT,
            checks: [],
            command: "check",
            counts: { errors: 0, informational: 0, passed: 0, warnings: 0 },
            diagnosticCount: 0,
            distroVersion: "1.2.3",
            durationMs: 1,
            exitCode: 0,
            flags: {
              dryRun: false,
              fix: false,
              interactive: false,
              json: false,
              online: false,
              verbose: false,
            },
            kind: "check-run",
          },
        ]),
      ),
      400,
    ],
    ["oversized declared body", post(batch(), { headers: { "content-length": "65537" } }), 413],
    ["oversized streamed body", post("x".repeat(65_537)), 413],
    ["wrong host", post(batch(), { url: "https://preview.example/api/telemetry/v1" }), 404],
  ])("rejects %s without scheduling persistence", async (_label, request, status) => {
    const test = fixture();

    const response = await handleRequest(request, test.environment, test.context);
    expect(response.status).toBe(status);
    expect(test.context.pending).toHaveLength(0);
    expect(test.database.batchCount).toBe(0);
  });

  it("rejects unsupported methods and advertises POST", async () => {
    const test = fixture();
    const response = await handleRequest(
      new Request(ENDPOINT, { method: "GET" }),
      test.environment,
      test.context,
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("returns 429 before reading or persisting a rate-limited body", async () => {
    const test = fixture({ rateAllowed: false });
    const response = await handleRequest(post(batch()), test.environment, test.context);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(test.context.pending).toHaveLength(0);
  });

  it("keeps unrelated paths on static assets and unknown telemetry paths private", async () => {
    const test = fixture();
    const install = await handleRequest(
      new Request("https://tryaura.sh/install"),
      test.environment,
      test.context,
    );
    const unknown = await handleRequest(
      new Request("https://tryaura.sh/api/telemetry/v2"),
      test.environment,
      test.context,
    );

    expect(await install.text()).toBe("asset");
    expect(test.assets.paths).toEqual(["/install"]);
    expect(unknown.status).toBe(404);
  });

  it("logs only a fixed message when asynchronous persistence fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const test = fixture({ databaseFailure: new Error("private database detail") });

    const response = await handleRequest(post(batch()), test.environment, test.context);
    expect(response.status).toBe(202);
    await test.context.settle();

    expect(error).toHaveBeenCalledExactlyOnceWith("Telemetry persistence failed.");
  });
});
