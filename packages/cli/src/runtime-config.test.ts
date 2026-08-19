import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineCheck, definePlugin, type AuraManifestState } from "@tryaura/aura-sdk";
import {
  createEmptyAuraManifest,
  createEnvironment,
  createPluginRegistry,
  hashRepoPreset,
} from "@tryaura/core";
import { describe, expect, it } from "vitest";

import { runCli } from "./index.js";
import { resolveRuntimeConfig } from "./runtime-config.js";
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

describe("repository preset layer", () => {
  const REPO_PRESET = JSON.stringify({
    checks: { severity: { "runtime/CHECK": "error" } },
    name: "Repo policy",
    schemaVersion: 1,
  });

  it("holds an untrusted repository preset without applying its values", async () => {
    const cwd = await workspaceWithRepoPreset(REPO_PRESET);
    const result = await resolveRuntimeConfig({
      environment: createEnvironment({ cwd, homeDir: join(cwd, "home") }),
      manifest: missingManifest(cwd),
      registry: createPluginRegistry([runtimePlugin(() => [])], {}),
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      return;
    }
    expect(result.repoPreset).toEqual({
      hash: hashRepoPreset(REPO_PRESET),
      path: join(cwd, ".aura", "preset.json"),
      status: "held",
    });
    expect(result.config.checks["runtime/CHECK"]?.severity.value).toBe("info");
  });

  it.each(["recorded", "accepted-this-run"])(
    "applies the layer for a %s trust of the exact contents",
    async (kind) => {
      const cwd = await workspaceWithRepoPreset(REPO_PRESET);
      const hash = hashRepoPreset(REPO_PRESET);
      const path = join(cwd, ".aura", "preset.json");
      const result = await resolveRuntimeConfig({
        ...(kind === "accepted-this-run" ? { acceptedRepoPresetHash: hash } : {}),
        environment: createEnvironment({ cwd, homeDir: join(cwd, "home") }),
        manifest: kind === "recorded" ? readyManifest(cwd, [{ hash, path }]) : missingManifest(cwd),
        registry: createPluginRegistry([runtimePlugin(() => [])], {}),
      });

      expect(result.status).toBe("ready");
      if (result.status !== "ready") {
        return;
      }
      expect(result.repoPreset).toMatchObject({ status: "applied" });
      expect(result.config.checks["runtime/CHECK"]?.severity).toEqual({
        provenance: { label: ".aura/preset.json", layer: "repo" },
        value: "error",
      });
    },
  );

  it("holds the layer when the recorded trust no longer matches the contents", async () => {
    const cwd = await workspaceWithRepoPreset(REPO_PRESET);
    const path = join(cwd, ".aura", "preset.json");
    const result = await resolveRuntimeConfig({
      environment: createEnvironment({ cwd, homeDir: join(cwd, "home") }),
      manifest: readyManifest(cwd, [{ hash: "a".repeat(64), path }]),
      registry: createPluginRegistry([runtimePlugin(() => [])], {}),
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      return;
    }
    expect(result.repoPreset).toMatchObject({ status: "held" });
    expect(result.config.checks["runtime/CHECK"]?.severity.value).toBe("info");
  });

  it("fails closed when the repository preset is unreadable", async () => {
    const cwd = await workspaceWithRepoPreset("{ broken");
    const result = await resolveRuntimeConfig({
      environment: createEnvironment({ cwd, homeDir: join(cwd, "home") }),
      manifest: missingManifest(cwd),
      registry: createPluginRegistry([runtimePlugin(() => [])], {}),
    });

    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") {
      return;
    }
    expect(result.message).toContain("is not valid JSON");
    expect(result.message).toContain("Fix or remove the file to continue.");
  });

  it("surfaces held state in JSON reports and JSON and human explanations", async () => {
    const cwd = await workspaceWithRepoPreset(REPO_PRESET);
    const runtime = { cwd, homeDir: join(cwd, "home") };
    const reportCapture = createCapture(["check", "--json"]);
    const jsonExplanation = createCapture(["check", "--explain", "runtime/CHECK", "--json"]);
    const humanExplanation = createCapture(["check", "--explain", "runtime/CHECK"]);
    const plugins = [runtimePlugin(() => [])];

    expect(await runCli(distro(plugins), { ...reportCapture.runtime, ...runtime })).toBe(0);
    expect(parseCheckReport(reportCapture.stdout.text).configuration).toEqual({
      repositoryPreset: { path: ".aura/preset.json", status: "held" },
    });

    expect(await runCli(distro(plugins), { ...jsonExplanation.runtime, ...runtime })).toBe(0);
    expect(parseCheckExplanation(jsonExplanation.stdout.text).configuration).toEqual({
      repositoryPreset: { path: ".aura/preset.json", status: "held" },
    });

    expect(await runCli(distro(plugins), { ...humanExplanation.runtime, ...runtime })).toBe(0);
    expect(humanExplanation.stdout.text).toContain(
      "Repository preset: .aura/preset.json — held because it is not trusted",
    );
  });
});

async function workspaceWithRepoPreset(content: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "aura-repo-layer-"));
  await mkdir(join(cwd, ".aura"));
  await writeFile(join(cwd, ".aura", "preset.json"), content, "utf8");
  return cwd;
}

function missingManifest(cwd: string): AuraManifestState {
  return { exists: false, path: join(cwd, "home", "agents", "aura.json"), status: "missing" };
}

function readyManifest(
  cwd: string,
  trustedRepoPresets: readonly { hash: string; path: string }[],
): AuraManifestState {
  return {
    exists: true,
    mode: 0o600,
    path: join(cwd, "home", "agents", "aura.json"),
    status: "ready",
    value: { ...createEmptyAuraManifest(), trustedRepoPresets },
  };
}

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
