import {
  decodeTelemetryBatchV1,
  type TelemetryBatchV1,
  type TelemetryEvent,
} from "@tryaura/aura-sdk";

import { isOfficialTelemetryBatch } from "./telemetry-policy.js";

const TELEMETRY_PATH = "/api/telemetry/v1";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_EVENTS = 5;
const RETENTION_DAYS = 90;
const RETENTION_SECONDS = RETENTION_DAYS * 24 * 60 * 60;
const INSERT_EVENT = `
  INSERT INTO telemetry_events (
    occurred_at,
    schema_version,
    kind,
    command,
    distro_version,
    exit_code,
    duration_ms,
    event_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;
const DELETE_EXPIRED_EVENTS = `
  DELETE FROM telemetry_events
  WHERE received_at < unixepoch() - ?
`;
const DELETE_EXPIRED_BUDGETS = `
  DELETE FROM telemetry_daily_budget
  WHERE day < date('now', ?)
`;

type DatabaseValue = string | number | null;

export interface TelemetryStatement {
  readonly bind: (...values: readonly DatabaseValue[]) => TelemetryStatement;
}

export interface TelemetryDatabase {
  readonly batch: (statements: readonly TelemetryStatement[]) => Promise<unknown>;
  readonly prepare: (query: string) => TelemetryStatement;
}

export interface TelemetryRateLimiter {
  readonly limit: (options: { readonly key: string }) => Promise<{ readonly success: boolean }>;
}

export interface TelemetryAssets {
  readonly fetch: (request: Request) => Promise<Response>;
}

export interface TelemetryWorkerEnvironment {
  readonly ASSETS: TelemetryAssets;
  readonly TELEMETRY_DB: TelemetryDatabase;
  readonly TELEMETRY_RATE_LIMIT: TelemetryRateLimiter;
}

export interface TelemetryExecutionContext {
  readonly waitUntil: (promise: Promise<unknown>) => void;
}

interface ReadBody {
  readonly bytes?: Uint8Array | undefined;
  readonly tooLarge: boolean;
}

export default {
  fetch(
    request: Request,
    environment: TelemetryWorkerEnvironment,
    context: TelemetryExecutionContext,
  ): Promise<Response> {
    return handleRequest(request, environment, context);
  },
  scheduled(
    _controller: unknown,
    environment: TelemetryWorkerEnvironment,
    context: TelemetryExecutionContext,
  ): void {
    const purged = purgeExpiredTelemetry(environment.TELEMETRY_DB).catch(() => {
      console.error("Telemetry retention failed.");
    });
    context.waitUntil(purged);
  },
};

/** Routes telemetry ingestion while leaving every unrelated request with the static asset worker. */
export async function handleRequest(
  request: Request,
  environment: TelemetryWorkerEnvironment,
  context: TelemetryExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== TELEMETRY_PATH) {
    if (url.pathname.startsWith("/api/telemetry/")) {
      return emptyResponse(404);
    }
    return environment.ASSETS.fetch(request);
  }
  if (!isAllowedHost(url.hostname)) {
    return emptyResponse(404);
  }
  if (request.method !== "POST") {
    return emptyResponse(405, { Allow: "POST" });
  }
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return emptyResponse(415);
  }

  const source = request.headers.get("cf-connecting-ip") ?? "unknown";
  const rate = await environment.TELEMETRY_RATE_LIMIT.limit({ key: source });
  if (!rate.success) {
    return emptyResponse(429, { "Retry-After": "60" });
  }

  if (declaredBodyTooLarge(request.headers.get("content-length"))) {
    return emptyResponse(413);
  }
  const body = await readBoundedBody(request);
  if (body.tooLarge) {
    return emptyResponse(413);
  }
  const batch = decodeBatch(body.bytes);
  if (batch === undefined) {
    return emptyResponse(400);
  }
  if (batch.events.length > MAX_EVENTS) {
    return emptyResponse(413);
  }
  if (!isOfficialTelemetryBatch(batch)) {
    return emptyResponse(400);
  }

  const persisted = persistEvents(environment.TELEMETRY_DB, batch).catch(() => {
    console.error("Telemetry persistence failed.");
  });
  context.waitUntil(persisted);
  return emptyResponse(202);
}

/** Deletes telemetry and its completed budget buckets after the documented retention period. */
export async function purgeExpiredTelemetry(database: TelemetryDatabase): Promise<void> {
  await database.batch([
    database.prepare(DELETE_EXPIRED_EVENTS).bind(RETENTION_SECONDS),
    database.prepare(DELETE_EXPIRED_BUDGETS).bind(`-${RETENTION_DAYS} days`),
  ]);
}

/** Converts validated events into the narrow, indexed row shape kept in D1. */
export async function persistEvents(
  database: TelemetryDatabase,
  batch: TelemetryBatchV1,
): Promise<void> {
  if (batch.events.length === 0) {
    return;
  }
  const statements = batch.events.map((event) =>
    database
      .prepare(INSERT_EVENT)
      .bind(
        event.at,
        batch.schemaVersion,
        event.kind,
        event.command,
        event.distroVersion ?? null,
        event.exitCode,
        eventDuration(event),
        JSON.stringify(event),
      ),
  );
  await database.batch(statements);
}

function eventDuration(event: TelemetryEvent): number | null {
  switch (event.kind) {
    case "check-run":
    case "setup-run":
      return event.durationMs;
    case "command-failed":
    case "fix-run":
    case "undo-run":
      return null;
  }
}

function isAllowedHost(hostname: string): boolean {
  return hostname === "tryaura.sh" || hostname === "localhost" || hostname === "127.0.0.1";
}

function isJsonContentType(contentType: string | null): boolean {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function declaredBodyTooLarge(contentLength: string | null): boolean {
  if (contentLength === null) {
    return false;
  }
  const bytes = Number(contentLength);
  return Number.isFinite(bytes) && bytes > MAX_BODY_BYTES;
}

async function readBoundedBody(request: Request): Promise<ReadBody> {
  if (request.body === null) {
    return { bytes: new Uint8Array(), tooLarge: false };
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    total += result.value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return { tooLarge: true };
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, tooLarge: false };
}

function decodeBatch(bytes: Uint8Array | undefined): TelemetryBatchV1 | undefined {
  if (bytes === undefined) {
    return undefined;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    return decodeTelemetryBatchV1(value);
  } catch {
    return undefined;
  }
}

function emptyResponse(status: number, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "no-store");
  return new Response(null, {
    headers: responseHeaders,
    status,
  });
}
