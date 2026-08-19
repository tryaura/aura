import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AuraManifestState } from "@tryaura/aura-sdk";
import { createEmptyAuraManifest, createEnvironment, hashRepoPreset } from "@tryaura/core";
import { describe, expect, it } from "vitest";

import { establishRepoPresetTrust, withTrustedRepoPreset } from "./repo-trust.js";
import { createScriptedWizardIo, type ScriptedWizardScript } from "./wizard-scripted.js";
import type { WizardConfirmation, WizardIo } from "./wizard-types.js";

const PRESET = '{"schemaVersion":1,"name":"Repo policy"}';

describe("establishRepoPresetTrust", () => {
  it("asks once interactively and returns the accepted hash", async () => {
    const cwd = await workspaceWithRepoPreset(PRESET);
    const harness = createHarness({ confirmations: ["accepted"] });

    const outcome = await establishRepoPresetTrust({
      environment: createEnvironment({ cwd, homeDir: join(cwd, "home") }),
      interactive: true,
      io: harness.io,
      manifest: missingManifest(cwd),
    });

    expect(outcome).toEqual({ acceptedHash: hashRepoPreset(PRESET), kind: "resolved" });
    expect(harness.confirmPrompts).toEqual([
      "Trust the repository preset at .aura/preset.json? Its settings apply to every Aura run in this repository until the file changes.",
    ]);
    expect(harness.io.notes[0]).toContain('provides the preset "Repo policy"');
    expect(harness.io.notes[1]).toContain("No check, MCP, skill, or snippet settings.");
  });

  it("shows every security-relevant capability before asking for trust", async () => {
    const preset = JSON.stringify({
      allowedSkillSources: ["directory:acme"],
      checks: { severity: { "runtime/CHECK": "error" } },
      requiredMcpServers: ["official/github"],
      schemaVersion: 1,
      skillDirectories: [
        {
          id: "directory:acme",
          name: "Acme Skills",
          tokenEnv: "ACME_TOKEN",
          url: "https://skills.acme.example",
        },
      ],
      skills: [{ id: "review", source: "directory:acme" }],
      snippets: ["official/engineering"],
    });
    const cwd = await workspaceWithRepoPreset(preset);
    const harness = createHarness({ confirmations: ["declined"] });

    await establishRepoPresetTrust({
      environment: createEnvironment({ cwd, homeDir: join(cwd, "home") }),
      interactive: true,
      io: harness.io,
      manifest: missingManifest(cwd),
    });

    const preview = harness.io.notes[1] ?? "";
    expect(preview).toContain('Checks: {"severity":{"runtime/CHECK":"error"}}');
    expect(preview).toContain("Required MCP servers: official/github");
    expect(preview).toContain("Allowed skill sources: directory:acme");
    expect(preview).toContain(
      "Skill directory: Acme Skills — https://skills.acme.example; token ACME_TOKEN",
    );
    expect(preview).toContain("Selected skills: directory:acme/review");
    expect(preview).toContain("Selected snippets: official/engineering");
  });

  it("never calls confirm when the run answers its own questions", async () => {
    const cwd = await workspaceWithRepoPreset(PRESET);
    const harness = createHarness();

    const outcome = await establishRepoPresetTrust({
      environment: createEnvironment({ cwd, homeDir: join(cwd, "home") }),
      interactive: false,
      io: harness.io,
      manifest: missingManifest(cwd),
    });

    expect(outcome).toEqual({ kind: "resolved" });
    expect(harness.confirmPrompts).toEqual([]);
  });

  it("does not re-ask for contents that are already trusted", async () => {
    const cwd = await workspaceWithRepoPreset(PRESET);
    const harness = createHarness();

    const outcome = await establishRepoPresetTrust({
      environment: createEnvironment({ cwd, homeDir: join(cwd, "home") }),
      interactive: true,
      io: harness.io,
      manifest: readyManifest(cwd, hashRepoPreset(PRESET)),
    });

    expect(outcome).toEqual({ kind: "resolved" });
    expect(harness.confirmPrompts).toEqual([]);
  });

  it("re-asks with the changed wording when trusted contents changed", async () => {
    const cwd = await workspaceWithRepoPreset(PRESET);
    const harness = createHarness({ confirmations: ["accepted"] });

    const outcome = await establishRepoPresetTrust({
      environment: createEnvironment({ cwd, homeDir: join(cwd, "home") }),
      interactive: true,
      io: harness.io,
      manifest: readyManifest(cwd, "a".repeat(64)),
    });

    expect(outcome).toEqual({ acceptedHash: hashRepoPreset(PRESET), kind: "resolved" });
    expect(harness.confirmPrompts).toEqual([
      "The repository preset at .aura/preset.json changed since you trusted it. Trust the new contents?",
    ]);
  });

  it.each<[WizardConfirmation, { kind: string }]>([
    ["declined", { kind: "resolved" }],
    ["back", { kind: "resolved" }],
    ["aborted", { kind: "aborted" }],
  ])("records nothing when the prompt is %s", async (confirmation, expected) => {
    const cwd = await workspaceWithRepoPreset(PRESET);
    const harness = createHarness({ confirmations: [confirmation] });

    const outcome = await establishRepoPresetTrust({
      environment: createEnvironment({ cwd, homeDir: join(cwd, "home") }),
      interactive: true,
      io: harness.io,
      manifest: missingManifest(cwd),
    });

    expect(outcome).toEqual(expected);
  });

  it("resolves without prompting when no repository preset exists", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "aura-setup-trust-"));
    const harness = createHarness();

    const outcome = await establishRepoPresetTrust({
      environment: createEnvironment({ cwd, homeDir: join(cwd, "home") }),
      interactive: true,
      io: harness.io,
      manifest: missingManifest(cwd),
    });

    expect(outcome).toEqual({ kind: "resolved" });
    expect(harness.confirmPrompts).toEqual([]);
  });
});

describe("withTrustedRepoPreset", () => {
  it("upserts by path and keeps other acceptances", () => {
    const manifest = {
      ...createEmptyAuraManifest(),
      trustedRepoPresets: [
        { hash: "a".repeat(64), path: "/one/.aura/preset.json" },
        { hash: "b".repeat(64), path: "/two/.aura/preset.json" },
      ],
    };

    const next = withTrustedRepoPreset(manifest, {
      hash: "c".repeat(64),
      path: "/one/.aura/preset.json",
    });

    expect(next.trustedRepoPresets).toEqual([
      { hash: "b".repeat(64), path: "/two/.aura/preset.json" },
      { hash: "c".repeat(64), path: "/one/.aura/preset.json" },
    ]);
  });

  it("drops the oldest acceptance instead of exceeding the schema bound", () => {
    const manifest = {
      ...createEmptyAuraManifest(),
      trustedRepoPresets: Array.from({ length: 64 }, (_unused, index) => ({
        hash: "a".repeat(64),
        path: `/repo-${String(index)}/.aura/preset.json`,
      })),
    };

    const next = withTrustedRepoPreset(manifest, {
      hash: "b".repeat(64),
      path: "/new/.aura/preset.json",
    });

    expect(next.trustedRepoPresets).toHaveLength(64);
    expect(next.trustedRepoPresets?.[0]?.path).toBe("/repo-1/.aura/preset.json");
    expect(next.trustedRepoPresets?.at(-1)?.path).toBe("/new/.aura/preset.json");
  });
});

async function workspaceWithRepoPreset(content: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "aura-setup-trust-"));
  await mkdir(join(cwd, ".aura"));
  await writeFile(join(cwd, ".aura", "preset.json"), content, "utf8");
  return cwd;
}

function missingManifest(cwd: string): AuraManifestState {
  return { exists: false, path: join(cwd, "home", "agents", "aura.json"), status: "missing" };
}

function readyManifest(cwd: string, hash: string): AuraManifestState {
  return {
    exists: true,
    mode: 0o600,
    path: join(cwd, "home", "agents", "aura.json"),
    status: "ready",
    value: {
      ...createEmptyAuraManifest(),
      trustedRepoPresets: [{ hash, path: join(cwd, ".aura", "preset.json") }],
    },
  };
}

interface Harness {
  readonly confirmPrompts: readonly string[];
  readonly io: WizardIo & { readonly notes: readonly string[] };
}

/** A scripted wizard that also records every confirmation prompt it was shown. */
function createHarness(script: ScriptedWizardScript = {}): Harness {
  const scripted = createScriptedWizardIo(script);
  const confirmPrompts: string[] = [];

  return {
    confirmPrompts,
    io: {
      ask: scripted.ask,
      confirm: async (prompt) => {
        confirmPrompts.push(prompt);
        return scripted.confirm(prompt);
      },
      load: scripted.load,
      note: scripted.note,
      notes: scripted.notes,
    },
  };
}
