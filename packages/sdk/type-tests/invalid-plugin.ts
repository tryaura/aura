// Negative type tests: every `@ts-expect-error` below asserts that the API rejects a shape a
// plugin author might plausibly write. An unused directive means the guarantee has regressed.
import {
  defineCheck,
  definePlugin,
  type Check,
  type DetectedFinding,
  type DirectoryContentSource,
  type FindingMetadataTableColumn,
  type FixPlan,
  type McpServerDef,
  type Preset,
  type Snippet,
} from "@tryaura/aura-sdk";

const snippet: Snippet = {
  description: "Adds the sample project's coding rules.",
  id: "example/rules",
  kind: "snippet",
  name: "Example rules",
  source: { type: "file", url: "file:///example-plugin/content/rules.md" },
  version: "1.0.0",
};

const preset: Preset = {
  description: "Selects all example contributions.",
  id: "example/default",
  kind: "preset",
  name: "Example default",
  source: { type: "file", url: "file:///example-plugin/content/preset.json" },
  version: "1.0.0",
};

const directorySource: DirectoryContentSource = {
  type: "directory",
  url: "file:///example-plugin/content/example-skill/",
};

const commonCheckFields = {
  defaultSeverity: "warn",
  detect: () => [],
  explain: "Invalid fixability shape.",
  id: "example/INVALID-FIXABILITY",
  scope: "global",
  title: "Invalid fixability",
} satisfies Pick<Check, "defaultSeverity" | "detect" | "explain" | "id" | "scope" | "title">;

definePlugin({
  // @ts-expect-error API v1 plugins must use the literal version 1.
  apiVersion: 2,
  id: "invalid-version",
  name: "Invalid version",
  version: "1.0.0",
});

// @ts-expect-error Plugins must declare an id and a version.
definePlugin({ apiVersion: 1, name: "Missing identity" });

defineCheck({
  defaultSeverity: "warn",
  // @ts-expect-error Detected findings must carry a stable id and a message.
  detect: () => [{ message: "Missing finding identity." }],
  explain: "Invalid check shape.",
  fixability: "manual",
  id: "example/INVALID",
  scope: "global",
  title: "Invalid check",
});

// @ts-expect-error Manual checks cannot provide an executable fix.
defineCheck({
  ...commonCheckFields,
  fix: () => undefined,
  fixability: "manual",
});

// @ts-expect-error Automatically fixable checks must provide a fix callback.
defineCheck({
  ...commonCheckFields,
  fixability: "auto",
});

// @ts-expect-error Guided checks must provide a fix callback.
defineCheck({
  ...commonCheckFields,
  fixability: "guided",
});

const contradictoryFinding: DetectedFinding = {
  // @ts-expect-error A check stamps its own id, scope, and severity onto every finding it emits.
  checkId: "example/OTHER",
  id: "example/INVALID-IDENTITY:global",
  message: "Findings cannot restate the identity of their check.",
};

// @ts-expect-error Boolean labels belong only to a column that asks for the boolean format.
const mislabeledColumn: FindingMetadataTableColumn = {
  falseLabel: "no",
  format: "integer",
  heading: "Bytes",
  key: "bytes",
  trueLabel: "yes",
};

const invalidSnippet: Snippet = {
  description: "Invalid source shape.",
  id: "example/invalid",
  kind: "snippet",
  name: "Invalid snippet",
  // @ts-expect-error Snippets must reference a file, not a directory.
  source: directorySource,
  version: "1.0.0",
};

// @ts-expect-error Contribution types are discriminated and not interchangeable.
const snippetAsPreset: Preset = snippet;

// @ts-expect-error Contribution types are discriminated and not interchangeable.
const presetAsMcpServer: McpServerDef = preset;

const invalidFixPlan: FixPlan = {
  operations: [
    {
      // @ts-expect-error Fix plans accept only the closed file-operation union.
      type: "execute",
    },
  ],
  summary: "Invalid fix",
};

const worldWritableFixPlan: FixPlan = {
  operations: [
    {
      content: "",
      // @ts-expect-error Fix plans cannot request group- or world-writable modes.
      mode: 0o777,
      path: "/tmp/example",
      type: "write",
    },
  ],
  summary: "Invalid mode",
};

void contradictoryFinding;
void mislabeledColumn;
void invalidSnippet;
void snippetAsPreset;
void presetAsMcpServer;
void invalidFixPlan;
void worldWritableFixPlan;
