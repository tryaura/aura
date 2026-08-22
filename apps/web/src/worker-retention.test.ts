import { describe, expect, it } from "vitest";

import {
  purgeExpiredTelemetry,
  type TelemetryDatabase,
  type TelemetryStatement,
} from "./worker.js";

type DatabaseValue = string | number | null;

class CapturingStatement implements TelemetryStatement {
  values: readonly DatabaseValue[] = [];

  bind(...values: readonly DatabaseValue[]): TelemetryStatement {
    this.values = values;
    return this;
  }
}

class CapturingDatabase implements TelemetryDatabase {
  readonly prepared: CapturingStatement[] = [];
  batchCount = 0;

  batch(_statements: readonly TelemetryStatement[]): Promise<unknown> {
    this.batchCount += 1;
    return Promise.resolve([]);
  }

  prepare(_query: string): TelemetryStatement {
    const statement = new CapturingStatement();
    this.prepared.push(statement);
    return statement;
  }
}

describe("telemetry retention", () => {
  it("purges expired events and completed budget buckets at the retention boundary", async () => {
    const database = new CapturingDatabase();

    await purgeExpiredTelemetry(database);

    expect(database.batchCount).toBe(1);
    expect(database.prepared).toHaveLength(2);
    expect(database.prepared[0]?.values).toEqual([90 * 24 * 60 * 60]);
    expect(database.prepared[1]?.values).toEqual(["-90 days"]);
  });
});
