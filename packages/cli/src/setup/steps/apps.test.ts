/* eslint-disable max-lines -- the application picker matrix keeps persistence cases together. */
import { describe, expect, it } from "vitest";

import type { AdapterSupportStatus, AuraManifestState } from "@tryaura/aura-sdk";
import { createWorkspaceModel } from "@tryaura/aura-sdk/testing";

import type { AppCatalogEntry } from "../catalog.js";
import { SETUP_ABORTED, type SetupStepContext } from "../types.js";
import { createScriptedWizardIo, type ScriptedWizardScript } from "../wizard-scripted.js";
import type { WizardIo, WizardQuestion } from "../wizard-types.js";
import { emptyMcpCatalog, emptySkillCatalog, emptySnippetCatalog } from "../testing.js";
import { appsStep } from "./apps.js";

describe("appsStep", () => {
  it("pre-checks every detected application and selects them by default", async () => {
    const catalog = [
      detected({ adapterId: "one", displayName: "One", version: "1.0.0" }),
      detected({ adapterId: "two", displayName: "Two", version: "2.0.0" }),
      detected({ adapterId: "three", displayName: "Three", version: "3.0.0" }),
    ];
    const harness = createHarness();

    const outcome = await appsStep.gather(context(catalog), harness.io);

    expect(harness.io.notes.filter((note) => note.startsWith("✓"))).toHaveLength(3);
    expect(question(harness).initial).toEqual(["one", "two", "three"]);
    expect(outcome).toEqual({ apps: { managed: ["one", "two", "three"] } });
  });

  it("offers a not-installed application and keeps it selectable", async () => {
    const catalog = [
      detected({ adapterId: "here", displayName: "Here", version: "1.0.0" }),
      undetected("missing", "Missing", "brew install missing", "the missing CLI on PATH"),
      undetected("scopeless", "Scopeless"),
    ];
    const harness = createHarness({
      forms: [{ apps: { kind: "options", values: ["here", "missing"] } }],
    });

    const outcome = await appsStep.gather(context(catalog), harness.io);

    expect(harness.io.notes).toContain("✗ Missing — looked for the missing CLI on PATH");
    expect(harness.io.notes).toContain("✗ Scopeless — not found");
    expect(question(harness).initial).toEqual(["here"]);
    expect(labels(harness)).toEqual([
      "Here 1.0.0",
      "Missing (not installed)",
      "Scopeless (not installed)",
    ]);
    expect(outcome).toEqual({ apps: { managed: ["here", "missing"] } });
  });

  it("explains a zero-detection machine and still offers the whole registry", async () => {
    const catalog = [undetected("one", "One"), undetected("two", "Two")];
    const harness = createHarness();

    const outcome = await appsStep.gather(context(catalog), harness.io);

    expect(harness.io.notes.join("\n")).toContain("No agent applications were detected.");
    expect(question(harness).options).toHaveLength(2);
    expect(question(harness).initial).toEqual([]);
    expect(outcome).toEqual({ apps: { managed: [] } });
  });

  it("keeps an ignored detected application unchecked and clears the ignore when selected", async () => {
    const catalog = [detected({ adapterId: "app", displayName: "App", version: "1.0.0" })];
    const manifest = manifestWith([]);
    if (manifest.status !== "ready") {
      throw new Error("expected a ready manifest");
    }
    const ignoredManifest: AuraManifestState = {
      ...manifest,
      value: { ...manifest.value, ignoredApps: ["app"] },
    };
    const harness = createHarness({
      forms: [{ apps: { kind: "options", values: ["app"] } }],
    });

    const outcome = await appsStep.gather(context(catalog, ignoredManifest), harness.io);

    expect(question(harness).initial).toEqual([]);
    expect(outcome).toEqual({ apps: { managed: ["app"] } });
  });

  it("flags an unsupported version but leaves the application pre-checked", async () => {
    const catalog = [
      detected({
        adapterId: "old",
        displayName: "Old",
        status: "unsupported",
        supportedRange: ">=2 <3",
        version: "3.1.0",
      }),
    ];
    const harness = createHarness();

    const outcome = await appsStep.gather(context(catalog), harness.io);

    expect(harness.io.notes).toContain(
      "⚠ Old 3.1.0 — unsupported version (supported: >=2 <3); fixes are downgraded",
    );
    expect(outcome).toEqual({ apps: { managed: ["old"] } });
  });

  it("flags an unauthenticated application", async () => {
    const catalog = [
      detected({ adapterId: "app", authenticated: false, displayName: "App", version: "1.0.0" }),
    ];
    const harness = createHarness();

    await appsStep.gather(context(catalog), harness.io);

    expect(harness.io.notes).toContain("⚠ App 1.0.0 (not authenticated)");
  });

  it("marks a previously-managed application even when it is no longer installed", async () => {
    const catalog = [
      detected({ adapterId: "here", displayName: "Here", version: "1.0.0" }),
      undetected("gone", "Gone"),
    ];
    const harness = createHarness();

    const outcome = await appsStep.gather(context(catalog, manifestWith(["gone"])), harness.io);

    expect(question(harness).initial).toEqual(["here", "gone"]);
    expect(labels(harness)).toEqual(["Here 1.0.0", "Gone (managed) (not installed)"]);
    expect(outcome).toEqual({ apps: { managed: ["here", "gone"] } });
  });

  it("asks before accepting that nothing will be managed", async () => {
    const catalog = [detected({ adapterId: "app", displayName: "App", version: "1.0.0" })];
    const none = { apps: { kind: "options", values: [] } } as const;
    const harness = createHarness({
      confirmations: ["declined", "accepted"],
      forms: [none, none],
    });

    const outcome = await appsStep.gather(context(catalog), harness.io);

    expect(harness.asked).toHaveLength(2);
    expect(outcome).toEqual({ apps: { ignored: ["app"], managed: [] } });
  });

  it("aborts from the empty-selection confirmation", async () => {
    const catalog = [detected({ adapterId: "app", displayName: "App", version: "1.0.0" })];
    const harness = createHarness({
      confirmations: ["aborted"],
      forms: [{ apps: { kind: "options", values: [] } }],
    });

    const outcome = await appsStep.gather(context(catalog), harness.io);

    expect(outcome).toBe(SETUP_ABORTED);
  });

  it("skips the confirmation when there was nothing to manage in the first place", async () => {
    const catalog = [undetected("one", "One")];
    const harness = createHarness();

    const outcome = await appsStep.gather(context(catalog), harness.io);

    expect(harness.confirmPrompts).toEqual([]);
    expect(outcome).toEqual({ apps: { managed: [] } });
  });

  it("aborts when the form is aborted", async () => {
    const catalog = [detected({ adapterId: "app", displayName: "App", version: "1.0.0" })];
    const harness = createHarness({ forms: ["aborted"] });

    const outcome = await appsStep.gather(context(catalog), harness.io);

    expect(outcome).toBe(SETUP_ABORTED);
  });

  it("preserves prior selections without prompting when no adapters are registered", async () => {
    const harness = createHarness();

    const outcome = await appsStep.gather(context([]), harness.io);

    expect(harness.asked).toEqual([]);
    expect(outcome).toEqual({});
  });
});

interface Harness {
  readonly asked: readonly (readonly WizardQuestion[])[];
  readonly confirmPrompts: readonly string[];
  readonly io: WizardIo & { readonly notes: readonly string[] };
}

/** A scripted wizard that also records every form and confirmation it was shown. */
function createHarness(script: ScriptedWizardScript = {}): Harness {
  const scripted = createScriptedWizardIo(script);
  const asked: (readonly WizardQuestion[])[] = [];
  const confirmPrompts: string[] = [];

  return {
    asked,
    confirmPrompts,
    io: {
      ask: async (questions) => {
        asked.push(questions);
        return scripted.ask(questions);
      },
      confirm: async (prompt) => {
        confirmPrompts.push(prompt);
        return scripted.confirm(prompt);
      },
      note: scripted.note,
      notes: scripted.notes,
    },
  };
}

function question(harness: Harness): WizardQuestion {
  const first = harness.asked[0]?.[0];
  if (first === undefined) {
    throw new Error("no question was asked");
  }
  return first;
}

function labels(harness: Harness): readonly string[] {
  return question(harness).options.map((option) => option.label);
}

function detected(options: {
  readonly adapterId: string;
  readonly authenticated?: boolean | undefined;
  readonly displayName: string;
  readonly status?: AdapterSupportStatus | undefined;
  readonly supportedRange?: string | undefined;
  readonly version?: string | undefined;
}): AppCatalogEntry {
  return {
    app: {
      adapterId: options.adapterId,
      detection: {
        authenticated: options.authenticated,
        installed: true,
        version: options.version,
      },
      displayName: options.displayName,
      instructionFiles: [],
      mcpServers: [],
      skills: [],
      sourceFiles: [],
      support: {
        status: options.status ?? "supported",
        supportedRange: options.supportedRange ?? ">=1",
        version: options.version,
      },
    },
    kind: "detected",
    supportsMcp: false,
    supportsSkills: false,
  };
}

function undetected(
  adapterId: string,
  displayName: string,
  installHint?: string,
  detectionScope?: string,
): AppCatalogEntry {
  return {
    adapterId,
    detectionScope,
    displayName,
    installHint,
    kind: "undetected",
    supportsMcp: false,
    supportsSkills: false,
  };
}

function manifestWith(managed: readonly string[]): AuraManifestState {
  return {
    exists: true,
    path: "/home/dev/agents/aura.json",
    status: "ready",
    value: {
      apps: Object.fromEntries(managed.map((id) => [id, { managed: true }])),
      mcpServers: [],
      ownership: {},
      schemaVersion: 1,
      skills: [],
      snippets: [],
    },
  };
}

function context(
  catalog: readonly AppCatalogEntry[],
  manifest: AuraManifestState = {
    exists: false,
    path: "/home/dev/agents/aura.json",
    status: "missing",
  },
): SetupStepContext {
  return {
    appCatalog: catalog,
    interactive: false,
    isEnvironmentVariableSet: () => false,
    manifest,
    mcpCatalog: emptyMcpCatalog(),
    model: createWorkspaceModel({
      manifest,
      sharedInstructions: { exists: false, path: "/home/dev/agents/AGENTS.md" },
    }),
    selections: {},
    skillCatalog: emptySkillCatalog(),
    snippetCatalog: emptySnippetCatalog(),
  };
}
