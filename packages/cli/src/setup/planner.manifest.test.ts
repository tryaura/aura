import { describe, expect, it } from "vitest";

import { parseAuraManifest } from "@tryaura/core";
import type { WorkspaceModel } from "@tryaura/aura-sdk";
import { createWorkspaceModel } from "@tryaura/aura-sdk/testing";

import type { AppCatalogEntry } from "./catalog.js";
import { planSetup } from "./planner.js";
import { emptySnippetCatalog } from "./testing.js";
import type { SetupStepContext } from "./types.js";

const PATH = "/home/dev/agents/aura.json";

describe("planSetup manifest app safety", () => {
  it("preserves managed apps that are unavailable in the current registry", () => {
    const outcome = planSetup(
      context(
        manifest({ available: { managed: true }, unavailable: { managed: true, note: "keep" } }),
        catalog("available"),
        [],
      ),
    );

    expect(outcome.manifest.apps).toEqual({
      available: { managed: false },
      unavailable: { managed: true, note: "keep" },
    });
    expect(outcome.plan.manualSteps).toEqual([
      "Aura stops managing available; its existing configuration is left in place.",
    ]);
  });

  it("round-trips a __proto__ app id as an own data property", () => {
    const source = `{"apps":{"__proto__":{"managed":false,"note":"keep"}},"mcpServers":[],"ownership":{},"schemaVersion":1,"skills":[],"snippets":[]}`;
    const outcome = planSetup(context(source, catalog("__proto__"), ["__proto__"]));
    const operation = outcome.plan.operations[0];
    if (operation?.type !== "write") {
      throw new Error("expected the manifest write operation");
    }
    const written = JSON.parse(operation.content);

    expect(Object.hasOwn(outcome.manifest.apps, "__proto__")).toBe(true);
    expect(outcome.manifest.apps["__proto__"]).toEqual({ managed: true, note: "keep" });
    expect(Object.hasOwn(written.apps, "__proto__")).toBe(true);
    expect(written.apps["__proto__"]).toEqual({ managed: true, note: "keep" });
  });

  // The convergence check compares desired against parsed state with `isDeepStrictEqual`, and both
  // sides carry `__proto__` as an own data property. A comparison that walked the prototype chain
  // instead would call these equal-looking manifests different and rewrite the file every run.
  it("plans nothing when a __proto__ app id already matches", () => {
    const source = `{"apps":{"__proto__":{"managed":true,"note":"keep"}},"mcpServers":[],"ownership":{},"schemaVersion":1,"skills":[],"snippets":[]}`;
    const outcome = planSetup(context(source, catalog("__proto__"), ["__proto__"]));

    expect(outcome.plan.operations).toEqual([]);
    expect(Object.hasOwn(outcome.manifest.apps, "__proto__")).toBe(true);
  });
});

function context(
  source: string,
  appCatalog: readonly AppCatalogEntry[],
  managed: readonly string[],
): SetupStepContext {
  const state = parseAuraManifest(source, PATH);
  if (state.status !== "ready") {
    throw new Error("expected a valid manifest fixture");
  }
  const model: WorkspaceModel = createWorkspaceModel({
    manifest: state,
    sharedInstructions: { content: "ready", exists: true, path: "/home/dev/agents/AGENTS.md" },
  });
  return {
    appCatalog,
    manifest: state,
    model,
    selections: { apps: { managed } },
    snippetCatalog: emptySnippetCatalog(),
  };
}

function manifest(apps: object): string {
  return JSON.stringify({
    apps,
    mcpServers: [],
    ownership: {},
    schemaVersion: 1,
    skills: [],
    snippets: [],
  });
}

function catalog(...ids: readonly string[]): readonly AppCatalogEntry[] {
  return ids.map((id) => ({ adapterId: id, displayName: id, kind: "undetected" }));
}
