import type { AuraEffectiveConfig } from "@tryaura/aura-sdk";
import { createEmptyAuraManifest, resolveEffectiveConfig } from "@tryaura/core";
import { describe, expect, it } from "vitest";

import type { RuntimeConfigResult } from "../runtime-config.js";
import { setupRepoPresetContext, withTrustedRepoPreset } from "./repo-trust.js";

describe("withTrustedRepoPreset", () => {
  it("keeps earlier accepted contents at the same path", () => {
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
      { hash: "a".repeat(64), path: "/one/.aura/preset.json" },
      { hash: "b".repeat(64), path: "/two/.aura/preset.json" },
      { hash: "c".repeat(64), path: "/one/.aura/preset.json" },
    ]);
  });

  it("moves an identical acceptance to the newest position without duplicating it", () => {
    const record = { hash: "a".repeat(64), path: "/one/.aura/preset.json" };
    const manifest = {
      ...createEmptyAuraManifest(),
      trustedRepoPresets: [record, { hash: "b".repeat(64), path: "/two/.aura/preset.json" }],
    };

    const next = withTrustedRepoPreset(manifest, record);

    expect(next.trustedRepoPresets).toEqual([
      { hash: "b".repeat(64), path: "/two/.aura/preset.json" },
      record,
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

  it("keeps acceptances for other contents of the same checkout", () => {
    const manifest = {
      ...createEmptyAuraManifest(),
      trustedRepoPresets: [
        {
          hash: "a".repeat(64),
          mainWorktreePath: "/repo/.aura/preset.json",
          path: "/trees/one/.aura/preset.json",
        },
      ],
    };

    const next = withTrustedRepoPreset(manifest, {
      hash: "b".repeat(64),
      mainWorktreePath: "/repo/.aura/preset.json",
      path: "/trees/two/.aura/preset.json",
    });

    expect(next.trustedRepoPresets).toHaveLength(2);
  });
});

describe("setupRepoPresetContext", () => {
  const HASH = "a".repeat(64);
  const configured = (
    repoPreset: Extract<RuntimeConfigResult, { status: "ready" }>["repoPreset"],
  ): Extract<RuntimeConfigResult, { status: "ready" }> => ({
    config: emptyConfig(),
    notes: [],
    presetOrigin: ".aura/preset.json",
    ...(repoPreset === undefined ? {} : { repoPreset }),
    status: "ready",
  });

  it("is absent when the run resolved no repository preset", () => {
    expect(setupRepoPresetContext(configured(undefined), HASH, false)).toBeUndefined();
  });

  it("accepts only the applied contents this run's prompt was shown", () => {
    const applied = { hash: HASH, path: "/repo/.aura/preset.json", status: "applied" } as const;
    const held = { hash: HASH, path: "/repo/.aura/preset.json", status: "held" } as const;

    expect(setupRepoPresetContext(configured(applied), HASH, false)?.accepted).toBe(true);
    expect(setupRepoPresetContext(configured(applied), "b".repeat(64), false)?.accepted).toBe(
      false,
    );
    expect(setupRepoPresetContext(configured(applied), undefined, false)?.accepted).toBe(false);
    expect(setupRepoPresetContext(configured(held), HASH, false)?.accepted).toBe(false);
  });

  it("carries whether the acceptance reached disk and which repository it belongs to", () => {
    const context = setupRepoPresetContext(
      configured({
        hash: HASH,
        mainWorktreePath: "/repo/.aura/preset.json",
        path: "/trees/one/.aura/preset.json",
        status: "applied",
      }),
      HASH,
      true,
    );

    expect(context).toMatchObject({
      mainWorktreePath: "/repo/.aura/preset.json",
      recorded: true,
    });
  });
});

function emptyConfig(): AuraEffectiveConfig {
  const resolved = resolveEffectiveConfig({ checks: [], knownMcpServers: new Set() });
  if (resolved.status !== "ready") {
    throw new Error("expected an empty configuration to resolve");
  }
  return resolved.config;
}
