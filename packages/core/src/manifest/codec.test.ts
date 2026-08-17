/* eslint-disable max-lines -- the manifest protocol matrix keeps every v1 field together. */
import { describe, expect, it } from "vitest";

import {
  AURA_MANIFEST_PATH,
  AURA_MANIFEST_SCHEMA_VERSION,
  createEmptyAuraManifest,
  parseAuraManifest,
  resolveAuraManifestPath,
  serializeAuraManifest,
} from "../index.js";

const PATH = "/home/dev/agents/aura.json";
const HASH = "a".repeat(64);

describe("Aura manifest protocol", () => {
  it("keeps its path and schema independent of distribution branding", () => {
    expect(AURA_MANIFEST_PATH).toBe("~/agents/aura.json");
    expect(AURA_MANIFEST_SCHEMA_VERSION).toBe(1);
    expect(resolveAuraManifestPath("/home/dev")).toBe(PATH);
  });

  it("creates the complete empty v1 shape", () => {
    expect(createEmptyAuraManifest()).toEqual({
      apps: {},
      mcpServers: [],
      ownership: {},
      schemaVersion: 1,
      skills: [],
      snippets: [],
    });
  });

  it("round-trips unknown fields at every known nesting level", () => {
    const source = {
      apps: { codex: { channel: "nightly", managed: true } },
      future: { enabled: true },
      mcpServers: [{ endpoint: { url: "https://example.test" }, name: "future" }],
      ownership: {
        codex: {
          files: ["~/.codex/AGENTS.md#aura-block"],
          generation: 7,
          mcpServerNames: ["github"],
        },
      },
      schemaVersion: 1,
      skills: [
        {
          channel: "nightly",
          id: "review",
          pinned: false,
          source: "plugin:official",
          treeHash: HASH,
          version: "1.2.3",
        },
      ],
      snippets: [
        {
          hash: HASH,
          id: "official/commit-conventions",
          pinned: false,
          provenance: { registry: "official" },
          version: "1.0.0",
        },
      ],
    };

    const state = parseAuraManifest(JSON.stringify(source), PATH);
    expect(state.status).toBe("ready");
    if (state.status !== "ready") {
      throw new Error("expected a ready manifest");
    }

    const serialized = serializeAuraManifest(state.value, PATH);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(JSON.parse(serialized)).toEqual(source);
  });

  it("preserves other apps and extension fields through add, disable, and remove edits", () => {
    const initial = parseAuraManifest(
      JSON.stringify({
        apps: { claude: { managed: true, note: "keep" } },
        mcpServers: [],
        ownership: {
          claude: { files: ["~/.claude/CLAUDE.md#aura-block"], mcpServerNames: ["owned"] },
        },
        schemaVersion: 1,
        skills: [],
        snippets: [],
        vendor: { future: true },
      }),
      PATH,
    );
    if (initial.status !== "ready") {
      throw new Error("expected a ready manifest");
    }

    const added = {
      ...initial.value,
      apps: { ...initial.value.apps, codex: { managed: true } },
      ownership: {
        ...initial.value.ownership,
        codex: { files: ["~/.codex/config.toml#aura-block"], mcpServerNames: [] },
      },
    };
    const disabled = {
      ...added,
      apps: { ...added.apps, codex: { ...added.apps.codex, managed: false } },
    };
    const removed = {
      ...disabled,
      apps: Object.fromEntries(Object.entries(disabled.apps).filter(([id]) => id !== "codex")),
      ownership: Object.fromEntries(
        Object.entries(disabled.ownership).filter(([id]) => id !== "codex"),
      ),
    };

    expect(JSON.parse(serializeAuraManifest(removed))).toEqual({
      apps: { claude: { managed: true, note: "keep" } },
      mcpServers: [],
      ownership: {
        claude: { files: ["~/.claude/CLAUDE.md#aura-block"], mcpServerNames: ["owned"] },
      },
      schemaVersion: 1,
      skills: [],
      snippets: [],
      vendor: { future: true },
    });
  });

  it.each([
    [{}, "$.schemaVersion", "must be an integer"],
    [{ schemaVersion: 1 }, "$.apps", "must be an object"],
    [
      {
        apps: { codex: { managed: "yes" } },
        mcpServers: [],
        ownership: {},
        schemaVersion: 1,
        skills: [],
        snippets: [],
      },
      "$.apps.codex.managed",
      "must be a boolean",
    ],
    [
      {
        apps: {},
        mcpServers: [],
        ownership: {},
        schemaVersion: 1,
        skills: [],
        snippets: [{ hash: "short", id: "x", pinned: false, version: "1" }],
      },
      "$.snippets[0].hash",
      "lowercase SHA-256",
    ],
    [
      {
        apps: {},
        mcpServers: [],
        ownership: {},
        schemaVersion: 1,
        skills: [
          { id: "review", pinned: false, source: "plugin:one", treeHash: HASH, version: "1" },
          { id: "review", pinned: false, source: "plugin:two", treeHash: HASH, version: "1" },
        ],
        snippets: [],
      },
      "$.skills[1].id",
      "must not duplicate",
    ],
    [
      {
        apps: {},
        mcpServers: [],
        ownership: {},
        schemaVersion: 1,
        skills: [
          { id: "Review", pinned: false, source: "plugin:official", treeHash: HASH, version: "1" },
        ],
        snippets: [],
      },
      "$.skills[0].id",
      "kebab-case skill ID",
    ],
    [
      {
        apps: {},
        mcpServers: [],
        ownership: {},
        schemaVersion: 1,
        skills: [{ id: "review", pinned: false, source: "official", treeHash: HASH, version: "1" }],
        snippets: [],
      },
      "$.skills[0].source",
      "plugin:, directory:, or driver:",
    ],
    [
      {
        apps: {},
        mcpServers: [],
        ownership: {},
        schemaVersion: 1,
        skills: [
          {
            id: "review",
            pinned: false,
            source: "plugin:official",
            treeHash: "short",
            version: "1",
          },
        ],
        snippets: [],
      },
      "$.skills[0].treeHash",
      "lowercase SHA-256",
    ],
    [
      {
        apps: {},
        mcpServers: [],
        ownership: { "odd.app": { files: [3], mcpServerNames: [] } },
        schemaVersion: 1,
        skills: [],
        snippets: [],
      },
      '$.ownership["odd.app"].files[0]',
      "must be a string",
    ],
  ])("reports the precise path for invalid known fields", (value, jsonPath, reason) => {
    const state = parseAuraManifest(JSON.stringify(value), PATH);

    expect(state.status).toBe("read-only");
    if (state.status !== "read-only") {
      throw new Error("expected a read-only manifest");
    }
    expect(state.problem).toMatchObject({ jsonPath, kind: "invalid-schema" });
    expect(state.problem.message).toContain(reason);
  });

  it("reports corrupt JSON safely with recovery guidance", () => {
    const state = parseAuraManifest('{"token":"secret",\n', PATH);

    expect(state.status).toBe("read-only");
    if (state.status !== "read-only") {
      throw new Error("expected a read-only manifest");
    }
    expect(state.problem).toMatchObject({ kind: "invalid-json" });
    expect(state.problem.message).toContain("Restore it from an Aura backup or move it aside");
    expect(state.problem.message).not.toContain("secret");
  });

  // Written as JSON text on purpose: `__proto__` in an object literal is the syntax that sets a
  // prototype, so a literal here would never produce the own property `JSON.parse` does.
  it("keeps a __proto__ extension field as data instead of a prototype", () => {
    const text = `{"apps":{"codex":{"managed":true}},"mcpServers":[],"ownership":{},"schemaVersion":1,"skills":[],"snippets":[],"vendor":{"__proto__":{"polluted":true},"keep":1}}`;

    const state = parseAuraManifest(text, PATH);
    if (state.status !== "ready") {
      throw new Error("expected a ready manifest");
    }
    const vendor = Object(Object(state.value)["vendor"]);
    expect(Object.getPrototypeOf(vendor)).toBe(Object.prototype);
    expect(Object.keys(vendor)).toEqual(["__proto__", "keep"]);

    // Assignment would have routed that one key through the inherited setter: silently dropped
    // from what Aura writes back, and installed as what the object inherits.
    const written = Object(JSON.parse(serializeAuraManifest(state.value, PATH)));
    expect(Object.keys(Object(written["vendor"]))).toEqual(["__proto__", "keep"]);
    expect(JSON.parse(serializeAuraManifest(state.value, PATH))).toEqual(JSON.parse(text));
  });

  it("makes an over-nested manifest read-only rather than overflowing the stack", () => {
    const depth = 40_000;
    const nested = `${"[".repeat(depth)}${"]".repeat(depth)}`;
    const text = `{"apps":{},"mcpServers":[],"ownership":{},"schemaVersion":1,"skills":[],"snippets":[],"vendor":${nested}}`;

    const state = parseAuraManifest(text, PATH);

    expect(state.status).toBe("read-only");
    if (state.status !== "read-only") {
      throw new Error("expected a read-only manifest");
    }
    expect(state.problem).toMatchObject({ kind: "invalid-schema" });
    expect(state.problem.message).toContain("nested deeper than");
  });

  it.each([0, 2])("makes unsupported schema version %s read-only", (schemaVersion) => {
    const state = parseAuraManifest(JSON.stringify({ schemaVersion }), PATH);

    expect(state.status).toBe("read-only");
    if (state.status !== "read-only") {
      throw new Error("expected a read-only manifest");
    }
    expect(state.problem).toMatchObject({
      actualVersion: schemaVersion,
      kind: "unsupported-version",
      supportedVersion: 1,
    });
    expect(state.problem.message).toContain(schemaVersion > 1 ? "Upgrade Aura" : "Restore");
  });
});
