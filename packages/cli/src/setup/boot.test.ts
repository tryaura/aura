import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { defineAdapter, definePlugin, type Environment, type ExecResult } from "@tryaura/aura-sdk";
import { createEnvironment, createPluginRegistry } from "@tryaura/core";
import { afterEach, describe, expect, it } from "vitest";

import { BRANDING, noopTelemetry } from "../testing.js";
import { bootSetup } from "./boot.js";
import type { SetupRequest } from "./setup.js";
import { createScriptedWizardIo } from "./wizard-scripted.js";
import type {
  WizardIo,
  WizardLoadRequest,
  WizardLoadStatus,
  WizardLoadUpdate,
} from "./wizard-types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("bootSetup", () => {
  it("waits for a slow adapter behind the scanning frame instead of a silent terminal", async () => {
    const root = await mkdtemp(join(tmpdir(), "aura-setup-boot-"));
    temporaryDirectories.push(root);
    const homeDir = join(root, "home");
    const workspace = join(root, "workspace");
    await mkdir(homeDir, { recursive: true });
    await mkdir(workspace, { recursive: true });
    const environment = createEnvironment({ cwd: workspace, environmentVariables: {}, homeDir });

    // The probe finishes only once the frame is open, so the wait is deterministically visible.
    let releaseDetect: () => void = () => undefined;
    const detectGate = new Promise<void>((resolve) => {
      releaseDetect = resolve;
    });
    const registry = createPluginRegistry(
      [
        definePlugin({
          adapters: [
            defineAdapter({
              detect: () => detectGate.then(() => ({ installed: false })),
              displayName: "Slow App",
              files: () => [],
              id: "slow-app",
              parse: () => ({ instructionFiles: [], mcpServers: [], skills: [] }),
              supportedRange: ">=1",
            }),
          ],
          apiVersion: 2,
          id: "slow",
          name: "Slow plugin",
          version: "1.0.0",
        }),
      ],
      {},
    );

    const requests: WizardLoadRequest[] = [];
    const updates: [string, WizardLoadStatus][] = [];
    const output = new PassThrough();
    const scripted = createScriptedWizardIo({ output });
    const io: WizardIo = {
      ...scripted,
      load: <T>(request: WizardLoadRequest, task: (update: WizardLoadUpdate) => Promise<T>) => {
        requests.push(request);
        releaseDetect();
        return task((id, status) => updates.push([id, status]));
      },
    };
    const request: SetupRequest = {
      branding: BRANDING,
      colorDepth: 0,
      dryRun: false,
      environment,
      interactive: false,
      io,
      registry,
      stateHomeDir: homeDir,
      stderr: new PassThrough(),
      stdout: output,
      telemetry: noopTelemetry(),
      withDetail: false,
    };

    const booted = await bootSetup(request, environment);

    expect(booted.status).toBe("ready");
    expect(requests).toEqual([
      {
        items: [{ id: "slow-app", label: "Slow App" }],
        prompt: "Scanning this machine…",
      },
    ]);
    expect(updates).toEqual([
      ["slow-app", "active"],
      ["slow-app", "complete"],
    ]);
  });

  it("cancels the speculative adapter scan when runtime configuration is invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "aura-setup-boot-cancel-"));
    temporaryDirectories.push(root);
    const homeDir = join(root, "home");
    const workspace = join(root, "workspace");
    await mkdir(homeDir, { recursive: true });
    await mkdir(workspace, { recursive: true });

    let markAdapterStarted: () => void = () => undefined;
    const adapterStarted = new Promise<void>((resolve) => {
      markAdapterStarted = resolve;
    });
    let scanSignal: AbortSignal | undefined;
    const base = createEnvironment({
      cwd: workspace,
      environmentVariables: {},
      homeDir,
      httpGet: async () => {
        await adapterStarted;
        return {
          body: JSON.stringify({ name: "Remote", schemaVersion: 1 }),
          kind: "response",
          status: 200,
        };
      },
    });
    const environment: Environment = {
      ...base,
      exec: (command) => {
        markAdapterStarted();
        scanSignal = command.signal;
        const signal = command.signal;
        if (signal === undefined) {
          return Promise.reject(new Error("adapter command did not receive scan cancellation"));
        }
        return new Promise<ExecResult>((resolve) => {
          const abort = (): void => resolve({ exitCode: 1, stderr: "aborted", stdout: "" });
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener("abort", abort, { once: true });
        });
      },
    };
    const registry = createPluginRegistry(
      [
        definePlugin({
          adapters: [
            defineAdapter({
              detect: async (runtime) => {
                await runtime.exec({ command: "slow-app" });
                return { installed: false };
              },
              displayName: "Slow App",
              files: () => [],
              id: "slow-app",
              parse: () => ({ instructionFiles: [], mcpServers: [], skills: [] }),
              supportedRange: ">=1",
            }),
          ],
          apiVersion: 2,
          id: "slow",
          name: "Slow plugin",
          version: "1.0.0",
        }),
      ],
      {},
    );
    const output = new PassThrough();
    const request: SetupRequest = {
      branding: BRANDING,
      cliLayer: { checks: { disabled: ["UNKNOWN-001"] } },
      colorDepth: 0,
      defaultPreset: "https://presets.example/remote.json",
      dryRun: false,
      environment,
      interactive: false,
      io: createScriptedWizardIo({ output }),
      noCache: true,
      registry,
      stateHomeDir: homeDir,
      stderr: new PassThrough(),
      stdout: output,
      telemetry: noopTelemetry(),
      withDetail: false,
    };

    const booted = await bootSetup(request, environment);

    expect(booted.status).toBe("invalid");
    expect(scanSignal).toBeDefined();
    expect(scanSignal?.aborted).toBe(true);
  });
});
