import { describe, expect, it } from "vitest";

// The real discovery loop, so these tests hold the generator to the contract adapters meet at
// scan time rather than to a second implementation of it.
import { discoverAdapterFiles } from "../packages/core/src/workspace/discovery.js";
import {
  discoverAdapterPaths,
  normalizeDocumentationPath,
  supportedAppsFromRegistry,
} from "./supported-apps-docs.mjs";
import {
  renderApplicationsTable,
  renderPathsTable,
  replaceSupportedAppsFragment,
} from "./supported-apps-table.mjs";

function spec(id, kind, path, scope = "project") {
  return { id, kind, optional: true, path, scope };
}

/**
 * Declares one path per kind the table renders, plus the two shapes the generator exists to
 * handle: a path only some platforms name, and a candidate probed before it is read.
 */
function fixtureAdapter(options = {}) {
  return {
    displayName: options.displayName ?? "Fixture Agent",
    files({ environment, files }) {
      const specs = [
        spec("instructions", "instructions", "/workspace/aura-docs/AGENTS.md"),
        spec("config", "config", "/home/aura-docs/.fixture/config.json", "global"),
        spec("skills", "skills", "/home/aura-docs/.fixture/skills", "global"),
        spec("probe", "probe", "/workspace/aura-docs/.fixture/candidate.md"),
      ];
      if (environment.platform === "darwin") {
        specs.push(spec("mac", "config", "/home/aura-docs/.fixture/mac.json", "global"));
      }
      if (files.get("probe")?.exists === true) {
        specs.push(spec("selected", "instructions", "/workspace/aura-docs/.fixture/candidate.md"));
      }
      return specs;
    },
    id: options.id ?? "fixture",
    supportedRange: options.supportedRange ?? ">=1 <2",
    synthetic: options.synthetic,
  };
}

describe("supported application discovery", () => {
  it("reports every kind of path an adapter reads, not only its configuration", async () => {
    expect(await discoverAdapterPaths(fixtureAdapter(), discoverAdapterFiles)).toEqual([
      { kind: "instructions", path: "./AGENTS.md" },
      { kind: "config", path: "~/.fixture/config.json" },
      { kind: "skills", path: "~/.fixture/skills" },
      // Probed on the empty machine, read once present: the read is what gets documented.
      { kind: "instructions", path: "./.fixture/candidate.md" },
      { kind: "config", path: "~/.fixture/mac.json", platforms: ["darwin"] },
    ]);
  });

  it("holds adapters to core's discovery round cap", async () => {
    let round = 0;
    const adapter = fixtureAdapter();
    adapter.files = () => [
      spec(`round-${String((round += 1))}`, "config", "/home/aura-docs/.fixture/config.json"),
    ];
    await expect(discoverAdapterPaths(adapter, discoverAdapterFiles)).rejects.toThrow(
      "file discovery did not stabilize within 16 rounds",
    );
  });

  it("rejects an adapter that changes a previously declared spec", async () => {
    const adapter = fixtureAdapter();
    let calls = 0;
    adapter.files = () => [
      spec("config", "config", `/home/aura-docs/.fixture/${String((calls += 1))}.json`),
    ];
    await expect(discoverAdapterPaths(adapter, discoverAdapterFiles)).rejects.toThrow(
      'redeclared file spec id "config" with a different definition',
    );
  });

  it("normalizes home and workspace paths and rejects other roots", () => {
    expect(normalizeDocumentationPath("/home/aura-docs/.fixture/config.json")).toBe(
      "~/.fixture/config.json",
    );
    expect(normalizeDocumentationPath("/workspace/aura-docs")).toBe(".");
    expect(() => normalizeDocumentationPath("/tmp/config.json")).toThrow(
      "outside the documentation roots",
    );
  });

  it("excludes synthetic adapters", async () => {
    const registry = {
      adapters: [fixtureAdapter(), fixtureAdapter({ id: "inventory", synthetic: true })],
    };
    expect(
      (await supportedAppsFromRegistry(registry, discoverAdapterFiles)).map((a) => a.id),
    ).toEqual(["fixture"]);
  });
});

describe("supported application rendering", () => {
  const apps = [
    {
      displayName: "Fixture | Agent",
      id: "fixture",
      paths: [
        { kind: "instructions", path: "./AGENTS.md" },
        { kind: "config", path: "~/.fixture/mac.json", platforms: ["darwin"] },
      ],
      supportedRange: ">=1 <2",
    },
  ];

  it("renders an aligned applications table", () => {
    expect(renderApplicationsTable(apps)).toMatchInlineSnapshot(`
      "| Adapter ID | Application      | Supported versions |
      | ---------- | ---------------- | ------------------ |
      | \`fixture\`  | Fixture \\| Agent | \`>=1 <2\`           |"
    `);
  });

  it("labels each path by what it is read for, marking platform-specific ones", () => {
    expect(renderPathsTable(apps)).toMatchInlineSnapshot(`
      "| Application      | Path                  | Read for               |
      | ---------------- | --------------------- | ---------------------- |
      | Fixture \\| Agent | \`./AGENTS.md\`         | Instructions           |
      | Fixture \\| Agent | \`~/.fixture/mac.json\` | Settings (darwin only) |"
    `);
  });

  it("rejects a file kind it has no label for", () => {
    expect(() =>
      renderPathsTable([{ ...apps[0], paths: [{ kind: "future", path: "./x" }] }]),
    ).toThrow("No documentation label for file kind future");
  });

  it("replaces only the generated fragment", () => {
    expect(
      replaceSupportedAppsFragment(
        "before\n<!-- supported-apps:begin -->\nold\n<!-- supported-apps:end -->\nafter\n",
        "new\nfragment",
      ),
    ).toBe(
      "before\n<!-- supported-apps:begin -->\n\nnew\nfragment\n\n<!-- supported-apps:end -->\nafter\n",
    );
  });

  it.each([
    ["missing markers", "body"],
    [
      "duplicate begin markers",
      "<!-- supported-apps:begin -->\n<!-- supported-apps:begin -->\n<!-- supported-apps:end -->",
    ],
    [
      "duplicate end markers",
      "<!-- supported-apps:begin -->\n<!-- supported-apps:end -->\n<!-- supported-apps:end -->",
    ],
  ])("rejects %s", (_name, source) => {
    expect(() => replaceSupportedAppsFragment(source, "table")).toThrow(
      "Expected exactly one supported-apps marker pair",
    );
  });

  it("rejects reversed markers", () => {
    expect(() =>
      replaceSupportedAppsFragment(
        "<!-- supported-apps:end -->\n<!-- supported-apps:begin -->",
        "table",
      ),
    ).toThrow("end marker must follow");
  });
});
