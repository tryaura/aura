import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AuraManifestState } from "@tryaura/aura-sdk";
import { createEmptyAuraManifest, createEnvironment, hashRepoPreset } from "@tryaura/core";
import { describe, expect, it } from "vitest";

import { establishRepoPresetTrust } from "./repo-trust.js";
import { createScriptedWizardIo, type ScriptedWizardScript } from "./wizard-scripted.js";
import type { WizardIo } from "./wizard-types.js";

const PRESET = '{"schemaVersion":1,"name":"Repo policy"}';

describe("establishRepoPresetTrust in a linked worktree", () => {
  it("does not ask in a linked worktree whose contents the primary checkout already trusts", async () => {
    const checkout = await checkoutWithWorktree(PRESET, PRESET);
    const harness = createHarness();

    const outcome = await establishRepoPresetTrust({
      environment: createEnvironment({
        cwd: checkout.worktree,
        homeDir: join(checkout.root, "home"),
      }),
      interactive: true,
      io: harness.io,
      manifest: trustingManifest(checkout.root, [
        { hash: hashRepoPreset(PRESET), path: join(checkout.main, ".aura", "preset.json") },
      ]),
    });

    expect(outcome).toEqual({ kind: "resolved" });
    expect(harness.confirmPrompts).toEqual([]);
  });

  it("asks as a first sighting in a worktree whose contents differ from what is trusted", async () => {
    const other = '{"schemaVersion":1,"name":"Branch policy"}';
    const checkout = await checkoutWithWorktree(PRESET, other);
    const harness = createHarness({ confirmations: ["accepted"] });

    const outcome = await establishRepoPresetTrust({
      environment: createEnvironment({
        cwd: checkout.worktree,
        homeDir: join(checkout.root, "home"),
      }),
      interactive: true,
      io: harness.io,
      manifest: trustingManifest(checkout.root, [
        { hash: hashRepoPreset(PRESET), path: join(checkout.main, ".aura", "preset.json") },
      ]),
    });

    expect(outcome).toEqual({ acceptedHash: hashRepoPreset(other), kind: "resolved" });
    expect(harness.confirmPrompts).toEqual([
      "Trust it? Applies to every run here until the file changes.",
    ]);
  });

  it("says what trusting a linked worktree reaches before asking", async () => {
    const checkout = await checkoutWithWorktree(PRESET, PRESET);
    const harness = createHarness({ confirmations: ["declined"] });

    await establishRepoPresetTrust({
      environment: createEnvironment({
        cwd: checkout.worktree,
        homeDir: join(checkout.root, "home"),
      }),
      interactive: true,
      io: harness.io,
      manifest: missingManifest(checkout.root),
    });

    expect(harness.io.notes[2]).toBe(
      "This directory is a linked worktree, so trusting these contents also applies them in every other worktree of the same checkout.",
    );
  });
});

interface Checkout {
  /** Primary checkout, holding a real `.git` directory. */
  readonly main: string;
  readonly root: string;
  /** Linked worktree, holding the `gitdir:` file Git leaves behind. */
  readonly worktree: string;
}

/** A primary checkout and one linked worktree, each carrying its own preset contents. */
async function checkoutWithWorktree(main: string, worktree: string): Promise<Checkout> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aura-setup-worktree-")));
  const mainRoot = join(root, "main");
  const worktreeRoot = join(root, "tree");
  await mkdir(join(mainRoot, ".git", "worktrees", "tree"), { recursive: true });
  await mkdir(join(mainRoot, ".aura"), { recursive: true });
  await writeFile(join(mainRoot, ".aura", "preset.json"), main, "utf8");
  await mkdir(join(worktreeRoot, ".aura"), { recursive: true });
  await writeFile(join(worktreeRoot, ".aura", "preset.json"), worktree, "utf8");
  await writeFile(
    join(worktreeRoot, ".git"),
    `gitdir: ${join(mainRoot, ".git", "worktrees", "tree")}\n`,
    "utf8",
  );
  return { main: mainRoot, root, worktree: worktreeRoot };
}

function missingManifest(root: string): AuraManifestState {
  return { exists: false, path: join(root, "home", "agents", "aura.json"), status: "missing" };
}

function trustingManifest(
  root: string,
  entries: readonly { hash: string; mainWorktreePath?: string; path: string }[],
): AuraManifestState {
  return {
    exists: true,
    mode: 0o600,
    path: join(root, "home", "agents", "aura.json"),
    status: "ready",
    value: { ...createEmptyAuraManifest(), trustedRepoPresets: entries },
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
