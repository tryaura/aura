import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineCheck, definePlugin } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { runCli } from "./index.js";
import { parseCheckExplanation, parseCheckReport } from "./test-support/check-output-schema.js";
import { createCapture, distro, findingPlugin, fixtureAdapter } from "./testing.js";

describe("runtime configuration", () => {
  it("resolves configuration before scanning adapters", async () => {
    let detections = 0;
    const adapterPlugin = definePlugin({
      adapters: [
        fixtureAdapter(() => {
          detections += 1;
          return { installed: true };
        }),
      ],
      apiVersion: 1,
      id: "runtime-adapter",
      name: "Runtime adapter",
      version: "1.0.0",
    });
    const preset = await presetFile({ checks: { disabled: ["unknown/CHECK"] } });
    const capture = createCapture(["check", "--preset", preset]);

    expect(await runCli(distro([adapterPlugin, runtimePlugin(() => [])]), capture.runtime)).toBe(2);
    expect(capture.stderr.text).toContain("Unknown check ID unknown/CHECK");
    expect(detections).toBe(0);
  });

  it("does not execute disabled checks and explains how to select one explicitly", async () => {
    let detections = 0;
    const plugin = runtimePlugin(() => {
      detections += 1;
      return [{ id: "finding", message: "should not execute" }];
    });
    const preset = await presetFile({ checks: { disabled: ["runtime/CHECK"] } });
    const disabled = createCapture(["check", "--preset", preset]);

    const exitCode = await runCli(distro([plugin, findingPlugin("info", [])]), disabled.runtime);
    expect({ exitCode, stderr: disabled.stderr.text }).toEqual({ exitCode: 0, stderr: "" });
    expect(detections).toBe(0);

    const selected = createCapture(["check", "--preset", preset, "--only", "runtime/check"]);
    expect(await runCli(distro([plugin]), selected.runtime)).toBe(2);
    expect(selected.stderr.text).toContain("add --enable runtime/check to run it");
    expect(detections).toBe(0);
  });

  it("passes inert thresholds to their check and applies effective severity to findings", async () => {
    const plugin = runtimePlugin((_model, settings) =>
      settings.thresholds["limit"] === 1
        ? [{ id: "configured", message: "configured", severity: "info" }]
        : [],
    );
    const preset = await presetFile({
      checks: {
        severity: { "runtime/CHECK": "error" },
        thresholds: { "runtime/CHECK": { limit: 1 } },
      },
    });
    const capture = createCapture(["check", "--preset", preset, "--json"]);

    expect(await runCli(distro([plugin]), capture.runtime)).toBe(2);
    expect(parseCheckReport(capture.stdout.text).findings).toMatchObject([
      { checkId: "runtime/CHECK", severity: "error" },
    ]);
  });

  it("shows preset and final CLI provenance without scanning", async () => {
    const preset = await presetFile({
      name: "Runtime team",
      checks: {
        disabled: ["runtime/CHECK"],
        severity: { "runtime/CHECK": "warn" },
        thresholds: { "runtime/CHECK": { limit: 1 } },
      },
    });
    const capture = createCapture([
      "check",
      "--explain",
      "runtime/CHECK",
      "--json",
      "--preset",
      preset,
      "--enable",
      "runtime/CHECK",
      "--severity",
      "runtime/CHECK=error",
      "--threshold",
      'runtime/CHECK={"limit":2}',
    ]);

    expect(await runCli(distro([runtimePlugin(() => [])]), capture.runtime)).toBe(0);
    expect(parseCheckExplanation(capture.stdout.text)).toMatchObject({
      enabled: true,
      preset: { name: "Runtime team", reference: preset },
      provenance: {
        enabled: { layer: "cli" },
        severity: { layer: "cli" },
        thresholds: { layer: "cli" },
      },
      severity: "error",
      thresholds: { limit: 2 },
    });
  });
});

function runtimePlugin(detect: Parameters<typeof defineCheck>[0]["detect"]) {
  return definePlugin({
    apiVersion: 1,
    checks: [
      defineCheck({
        defaultSeverity: "info",
        detect,
        explain: "Runtime configuration fixture.",
        fixability: "manual",
        id: "runtime/CHECK",
        scope: "global",
        title: "Runtime check",
      }),
    ],
    id: "runtime",
    name: "Runtime",
    version: "1.0.0",
  });
}

async function presetFile(fields: Readonly<Record<string, unknown>>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aura-runtime-preset-"));
  const path = join(directory, "preset.json");
  await writeFile(path, JSON.stringify({ ...fields, schemaVersion: 1 }), "utf8");
  return path;
}
