import { describe, expect, it } from "vitest";

import type { ContributionKind, PluginCandidate, PluginRegistryOptions } from "./index.js";
import {
  captureRegistryError,
  createAdapter,
  createCheck,
  createMcpServer,
  createPlugin,
  createPreset,
  createSkill,
  createSkillSource,
  createSnippet,
} from "./plugin-fixtures.js";

interface CollisionCase {
  readonly candidates: readonly PluginCandidate[];
  readonly id: string;
  readonly kind: ContributionKind;
  readonly options?: PluginRegistryOptions | undefined;
  readonly originalPlugin: string;
  readonly offendingPlugin: string;
}

interface NamespaceCase {
  readonly candidates: readonly PluginCandidate[];
  readonly id: string;
  readonly kind: ContributionKind;
}

describe("plugin validation", () => {
  it("rejects an unsupported API version and names the upgrade to make", () => {
    const futureError = captureRegistryError([
      createPlugin("future", { apiVersion: 2, name: "Future Plugin" }),
    ]);
    const staleError = captureRegistryError([
      createPlugin("stale", { apiVersion: 0, name: "Stale Plugin" }),
    ]);

    expect(futureError.message).toContain('Plugin "Future Plugin" (future)');
    expect(futureError.message).toContain("unsupported apiVersion 2");
    expect(futureError.message).toContain("supports apiVersion 1");
    expect(futureError.message).toContain("Upgrade Aura");
    expect(staleError.message).toContain("Upgrade the plugin");
  });

  it("reports every problem across every plugin in one error", () => {
    const error = captureRegistryError([
      createPlugin("acme", { checks: [createCheck("SEC-001")], name: "Acme" }),
      createPlugin("beta", { name: "Beta", snippets: [createSnippet("rules")] }),
      createPlugin("gamma", { apiVersion: 3, name: "Gamma" }),
    ]);

    expect(error.message).toContain("(3 problems)");
    expect(error.message).toContain('check ID "SEC-001"');
    expect(error.message).toContain('snippet ID "rules"');
    expect(error.message).toContain("unsupported apiVersion 3");
  });

  it("rejects duplicate plugin IDs and identifies both plugins", () => {
    const error = captureRegistryError([
      createPlugin("shared", { name: "Original Plugin" }),
      createPlugin("shared", { name: "Offending Plugin" }),
    ]);

    expect(error.message).toContain('Plugin "Offending Plugin" (shared)');
    expect(error.message).toContain('duplicate plugin ID "shared"');
    expect(error.message).toContain('Plugin "Original Plugin" (shared)');
  });

  it("rejects duplicate contribution IDs within or across plugins", () => {
    const cases: readonly CollisionCase[] = [
      {
        candidates: [
          createPlugin("alpha", {
            adapters: [createAdapter("shared-agent"), createAdapter("shared-agent")],
            name: "Alpha Plugin",
          }),
        ],
        id: "shared-agent",
        kind: "adapter",
        offendingPlugin: "Alpha Plugin",
        originalPlugin: "Alpha Plugin",
      },
      {
        candidates: [
          createPlugin("alpha", {
            adapters: [createAdapter("shared-agent")],
            name: "Alpha Plugin",
          }),
          createPlugin("beta", { adapters: [createAdapter("shared-agent")], name: "Beta Plugin" }),
        ],
        id: "shared-agent",
        kind: "adapter",
        offendingPlugin: "Beta Plugin",
        originalPlugin: "Alpha Plugin",
      },
      {
        candidates: [
          createPlugin("alpha", {
            checks: [createCheck("alpha/SEC-001"), createCheck("alpha/SEC-001")],
            name: "Alpha Plugin",
          }),
        ],
        id: "alpha/SEC-001",
        kind: "check",
        offendingPlugin: "Alpha Plugin",
        originalPlugin: "Alpha Plugin",
      },
      {
        candidates: [
          createPlugin("official-one", { checks: [createCheck("INS-001")], name: "Official One" }),
          createPlugin("official-two", { checks: [createCheck("INS-001")], name: "Official Two" }),
        ],
        id: "INS-001",
        kind: "check",
        offendingPlugin: "Official Two",
        options: { bareCheckIdPlugins: ["official-one", "official-two"] },
        originalPlugin: "Official One",
      },
      {
        candidates: [
          createPlugin("alpha", {
            name: "Alpha Plugin",
            snippets: [createSnippet("alpha/rules"), createSnippet("alpha/rules")],
          }),
        ],
        id: "alpha/rules",
        kind: "snippet",
        offendingPlugin: "Alpha Plugin",
        originalPlugin: "Alpha Plugin",
      },
      {
        candidates: [
          createPlugin("alpha", {
            name: "Alpha Plugin",
            skills: [createSkill("review"), createSkill("review")],
          }),
        ],
        id: "plugin:alpha/review",
        kind: "skill-pack",
        offendingPlugin: "Alpha Plugin",
        originalPlugin: "Alpha Plugin",
      },
      {
        candidates: [
          createPlugin("alpha", {
            mcpCatalog: [createMcpServer("alpha/search"), createMcpServer("alpha/search")],
            name: "Alpha Plugin",
          }),
        ],
        id: "alpha/search",
        kind: "mcp-server",
        offendingPlugin: "Alpha Plugin",
        originalPlugin: "Alpha Plugin",
      },
      {
        candidates: [
          createPlugin("alpha", {
            name: "Alpha Plugin",
            presets: [createPreset("alpha/starter"), createPreset("alpha/starter")],
          }),
        ],
        id: "alpha/starter",
        kind: "preset",
        offendingPlugin: "Alpha Plugin",
        originalPlugin: "Alpha Plugin",
      },
      {
        candidates: [
          createPlugin("alpha", {
            name: "Alpha Plugin",
            skillSources: [createSkillSource("alpha/reg"), createSkillSource("alpha/reg")],
          }),
        ],
        id: "alpha/reg",
        kind: "skill-source",
        offendingPlugin: "Alpha Plugin",
        originalPlugin: "Alpha Plugin",
      },
    ];

    for (const collision of cases) {
      const error = captureRegistryError(collision.candidates, collision.options);

      expect(error.message).toContain(`Plugin "${collision.offendingPlugin}"`);
      expect(error.message).toContain(`duplicate ${collision.kind} ID "${collision.id}"`);
      expect(error.message).toContain(`Plugin "${collision.originalPlugin}"`);
    }
  });

  it("rejects check IDs outside the owning namespace", () => {
    const bareError = captureRegistryError([
      createPlugin("acme", { checks: [createCheck("SEC-001")], name: "Acme" }),
    ]);
    const wrongNamespaceError = captureRegistryError(
      [createPlugin("core", { checks: [createCheck("other/INS-001")], name: "Core" })],
      { bareCheckIdPlugins: ["core"] },
    );

    expect(bareError.message).toContain('Plugin "Acme" (acme)');
    expect(bareError.message).toContain('check ID "SEC-001"');
    expect(bareError.message).toContain('"acme/<id>" namespace');
    expect(wrongNamespaceError.message).toContain('check ID "other/INS-001"');
    expect(wrongNamespaceError.message).toContain('"core/<id>" namespace');
  });

  it("rejects content contribution IDs outside the owning namespace", () => {
    const cases: readonly NamespaceCase[] = [
      {
        candidates: [createPlugin("acme", { name: "Acme", snippets: [createSnippet("rules")] })],
        id: "rules",
        kind: "snippet",
      },
      {
        candidates: [createPlugin("acme", { mcpCatalog: [createMcpServer("q")], name: "Acme" })],
        id: "q",
        kind: "mcp-server",
      },
      {
        candidates: [createPlugin("acme", { name: "Acme", presets: [createPreset("starter")] })],
        id: "starter",
        kind: "preset",
      },
      {
        candidates: [
          createPlugin("acme", { name: "Acme", skillSources: [createSkillSource("reg")] }),
        ],
        id: "reg",
        kind: "skill-source",
      },
      {
        // The namespace prefix on its own is not an id.
        candidates: [createPlugin("acme", { name: "Acme", snippets: [createSnippet("acme/")] })],
        id: "acme/",
        kind: "snippet",
      },
    ];

    for (const namespaceCase of cases) {
      const error = captureRegistryError(namespaceCase.candidates);

      expect(error.message).toContain('Plugin "Acme" (acme)');
      expect(error.message).toContain(`${namespaceCase.kind} ID "${namespaceCase.id}"`);
      expect(error.message).toContain('"acme/<id>" namespace');
    }
  });

  it("rejects malformed plugin identity fields", () => {
    const idError = captureRegistryError([createPlugin("Acme/Rules", { name: "Acme" })]);
    const nameError = captureRegistryError([createPlugin("acme", { name: "  " })]);
    const versionError = captureRegistryError([
      createPlugin("acme", { name: "Acme", version: "v1" }),
    ]);

    expect(idError.message).toContain('Plugin "Acme" declares ID "Acme/Rules"');
    expect(idError.message).toContain("cannot be used as an ID namespace");
    expect(nameError.message).toContain('Plugin "acme" declares an empty name');
    expect(versionError.message).toContain('declares version "v1"');
    expect(versionError.message).toContain("semver");
  });

  it("skips the contributions of a plugin whose identity is unusable", () => {
    const error = captureRegistryError([
      createPlugin("Acme", { checks: [createCheck("SEC-001")], name: "Acme" }),
    ]);

    // Only the root cause is reported; the namespace error it would cascade into is suppressed.
    expect(error.message).toContain("cannot be used as an ID namespace");
    expect(error.message).not.toContain('check ID "SEC-001"');
  });

  it("rejects a bare check ID grant that matches no loaded plugin", () => {
    const error = captureRegistryError([createPlugin("core", { name: "Core" })], {
      bareCheckIdPlugins: ["core", "cor"],
    });

    expect(error.message).toContain('bareCheckIdPlugins names "cor"');
    expect(error.message).not.toContain('names "core"');
  });
});
