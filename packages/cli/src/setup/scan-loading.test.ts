import { defineAdapter, type Adapter } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { trackBootScan } from "./scan-loading.js";
import type {
  WizardIo,
  WizardLoadRequest,
  WizardLoadStatus,
  WizardLoadUpdate,
} from "./wizard-types.js";

function fakeAdapter(id: string, displayName: string): Adapter {
  return defineAdapter({
    detect: () => Promise.resolve({ installed: false }),
    displayName,
    files: () => [],
    id,
    parse: () => ({ instructionFiles: [], mcpServers: [], skills: [] }),
    supportedRange: ">=1 <2",
  });
}

/** An io whose load records the request and every update the task reports through it. */
function recordingIo(record: {
  requests: WizardLoadRequest[];
  updates: [string, WizardLoadStatus][];
}): WizardIo {
  return {
    ask: () => Promise.resolve("aborted"),
    confirm: () => Promise.resolve("aborted"),
    load: <T>(request: WizardLoadRequest, task: (update: WizardLoadUpdate) => Promise<T>) => {
      record.requests.push(request);
      return task((id, status) => record.updates.push([id, status]));
    },
    note: () => undefined,
  };
}

describe("trackBootScan", () => {
  it("opens a loading frame naming every adapter and replays progress reported before it", async () => {
    const adapters = [fakeAdapter("claude-code", "Claude Code"), fakeAdapter("cursor", "Cursor")];
    let finish: (value: string) => void = () => undefined;
    let report: (adapterId: string, status: WizardLoadStatus) => void = () => undefined;
    const settle = trackBootScan(adapters, (reporter) => {
      report = reporter;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    // Progress lands while a prompt is still open, before any frame exists to receive it.
    report("claude-code", "active");
    report("claude-code", "complete");
    report("cursor", "active");

    const record: Parameters<typeof recordingIo>[0] = { requests: [], updates: [] };
    const pending = settle(recordingIo(record));
    report("cursor", "complete");
    finish("scan");

    await expect(pending).resolves.toBe("scan");
    expect(record.requests).toEqual([
      {
        items: [
          { id: "claude-code", label: "Claude Code" },
          { id: "cursor", label: "Cursor" },
        ],
        prompt: "Scanning this machine…",
      },
    ]);
    expect(record.updates).toEqual([
      ["claude-code", "complete"],
      ["cursor", "active"],
      ["cursor", "complete"],
    ]);
  });

  it("skips the frame entirely when the scan settled before the wizard needed it", async () => {
    const settle = trackBootScan([fakeAdapter("codex", "Codex")], () => Promise.resolve("done"));
    // The settlement callback runs on the microtask queue; give it one turn.
    await Promise.resolve();

    const record: Parameters<typeof recordingIo>[0] = { requests: [], updates: [] };
    await expect(settle(recordingIo(record))).resolves.toBe("done");
    expect(record.requests).toEqual([]);
  });

  it("opens no frame for a registry without adapters, whatever the scan's timing", async () => {
    let finish: (value: string) => void = () => undefined;
    const settle = trackBootScan(
      [],
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );

    const record: Parameters<typeof recordingIo>[0] = { requests: [], updates: [] };
    const pending = settle(recordingIo(record));
    finish("scan");

    await expect(pending).resolves.toBe("scan");
    expect(record.requests).toEqual([]);
  });

  it("holds a scan failure for settle instead of rejecting unhandled", async () => {
    const settle = trackBootScan([fakeAdapter("codex", "Codex")], () =>
      Promise.reject(new Error("scan exploded")),
    );
    // The rejection lands while nothing awaits it yet; the tracker must have it handled by now.
    await new Promise((resolve) => setImmediate(resolve));

    const record: Parameters<typeof recordingIo>[0] = { requests: [], updates: [] };
    await expect(settle(recordingIo(record))).rejects.toThrow("scan exploded");
  });
});
