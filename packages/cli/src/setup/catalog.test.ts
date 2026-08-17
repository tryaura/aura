import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildWorkspaceModel, createEnvironment, type WorkspaceScan } from "@tryaura/core";
import { defineAdapter, type Adapter } from "@tryaura/aura-sdk";

import { buildAppCatalog, catalogEntryId, catalogEntryName } from "./catalog.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("buildAppCatalog", () => {
  it("keeps registry order and marks an absent application undetected", async () => {
    const adapters = [adapter("here", "Here", true), adapter("gone", "Gone", false)];
    const scanned = await scan(adapters);

    const catalog = buildAppCatalog(adapters, scanned.model, scanned.skipped);

    expect(catalog.map(catalogEntryId)).toEqual(["here", "gone"]);
    expect(catalog.map(catalogEntryName)).toEqual(["Here", "Gone"]);
    expect(catalog.map((entry) => entry.kind)).toEqual(["detected", "undetected"]);
  });

  it("carries the detection scope of an application that was looked for and not found", async () => {
    const adapters = [
      { ...adapter("gone", "Gone", false), detectionScope: "the gone CLI on PATH" },
    ];
    const scanned = await scan(adapters);

    const catalog = buildAppCatalog(adapters, scanned.model, scanned.skipped);

    expect(catalog[0]).toMatchObject({
      detectionScope: "the gone CLI on PATH",
      kind: "undetected",
    });
  });

  it("drops the detection scope of an adapter that threw before it could look", async () => {
    const adapters = [
      {
        ...adapter("broken", "Broken", false),
        detect: () => Promise.reject(new Error("adapter exploded")),
        detectionScope: "the broken CLI on PATH",
      },
    ];
    const scanned = await scan(adapters);

    const catalog = buildAppCatalog(adapters, scanned.model, scanned.skipped);

    expect(scanned.diagnostics.map((diagnostic) => diagnostic.phase)).toEqual(["detect"]);
    expect(catalog[0]).toMatchObject({ detectionScope: undefined, kind: "undetected" });
  });

  it("omits a synthetic inventory adapter even though it reports itself installed", async () => {
    const adapters = [
      adapter("real", "Real App", true),
      { ...adapter("file-inventory", "File inventory", true), synthetic: true },
    ];
    const scanned = await scan(adapters);

    const catalog = buildAppCatalog(adapters, scanned.model, scanned.skipped);

    expect(scanned.model.apps.map((app) => app.adapterId)).toContain("file-inventory");
    expect(catalog.map(catalogEntryId)).toEqual(["real"]);
  });
});

function adapter(id: string, displayName: string, installed: boolean): Adapter {
  return defineAdapter({
    detect: () => Promise.resolve(installed ? { installed, version: "1.0.0" } : { installed }),
    displayName,
    files: () => [],
    id,
    parse: () => ({ instructionFiles: [], mcpServers: [], skills: [] }),
    supportedRange: ">=1 <2",
  });
}

async function scan(adapters: readonly Adapter[]): Promise<WorkspaceScan> {
  const root = await mkdtemp(join(tmpdir(), "aura-setup-catalog-"));
  temporaryDirectories.push(root);
  const homeDir = join(root, "home");
  const workspace = join(root, "workspace");
  await mkdir(homeDir, { recursive: true });
  await mkdir(workspace, { recursive: true });

  const environment = createEnvironment({ cwd: workspace, environmentVariables: {}, homeDir });
  return buildWorkspaceModel({ adapters, environment });
}
