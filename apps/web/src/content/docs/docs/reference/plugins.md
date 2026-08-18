---
title: Plugins
description: Contribution slots available to an Aura plugin and the rules the registry enforces.
---

A plugin is created with `definePlugin` and declares an `id`, a `name`, a `version`, and
`apiVersion: 1`. Aura v1 loads only plugins declaring `apiVersion: 1`; anything else is rejected at
registration.

## Contribution slots

Every slot is optional.

| Slot               | Purpose                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `adapters`         | Detect an agent application, declare files for core to read, parse contents into a normalized snapshot. |
| `checks`           | Synchronously inspect the `WorkspaceModel` and optionally return a `FixPlan`.                           |
| `snippets`         | Reference Markdown files.                                                                               |
| `skills`           | Reference skill directories.                                                                            |
| `skillDirectories` | Remote directories served through Aura's standard bounded HTTP protocol.                                |
| `skillSources`     | Build-time drivers that list and resolve non-standard external skills.                                  |
| `mcpCatalog`       | Reference JSON MCP catalog entries.                                                                     |
| `presets`          | Reference JSON preset definitions.                                                                      |

## Namespacing

Most contribution IDs are namespaced under the plugin's own ID. Plugin `acme` contributes
`acme/rules`, never `rules`. Bundled skills are the exception: their kebab-case IDs are local to
their source, so `review` from `plugin:acme` and `review` from another source can coexist in the
catalog. The registry validates versions, IDs, and composite source/skill collisions.

## Content references

Content references must be absolute `file:` URLs, constructed relative to the plugin module:

```ts
const url = new URL("./content/preset.json", import.meta.url).href;
```

Working-directory-relative paths do not work. Existence and schema validation happen when the
registry loads the contribution, not at first use.

Plugin authors need `@types/node` in their `tsconfig` for the `import.meta.url` idiom above.

## What a check may do

Checks are synchronous and pure. They never read from disk or inspect the process environment. A
check emits `DetectedFinding` values carrying only occurrence-specific data — `id`, `message`, and
optionally `details`, `locations`, `metadata`, `presentation`, and a `severity` override.
`presentation` can ask a human renderer to display a metadata array as a generic table; the
structured metadata remains the source of truth in JSON output. Core stamps on `checkId`, `scope`,
and the resolved severity, so a finding cannot contradict the check that produced it.

:::danger[Never put secrets in metadata]
Every `metadata` field is rendered into reports, logs, and CI output. Note how
`StdioMcpTransport.environmentVariables` carries variable _names_ and never values — follow that
pattern.
:::

`WorkspaceModel` spans every application, so a check sees instruction content and MCP configuration
contributed by adapters from other plugins. Do not copy `InstructionDocument` content into a
finding.

Adapters may opt into manifest-driven MCP remediation with a pure `mcpWrite` serializer. It receives
one declared MCP file's existing contents, the desired owned servers for that file's scope, and the
application's ownership-ledger names, and returns either `{ content }` or `{ refusal }`. It must
preserve unrelated entries and refuse malformed or unrepresentable configuration rather than
guessing. Core keeps the captured bytes to itself: a check sees `McpConvergenceBlocker` values and
never the rendered file, and every successful write carries the digest of what was read, so a
configuration the application rewrote in the meantime becomes a preview conflict instead of a silent
revert.

A parser reports every named entry it finds. One it cannot model — turned off, or written in a shape
it does not recognize — belongs in `AdapterSnapshot.unusableMcpServers` rather than being dropped,
so a check can tell "no such server" from "declared but not running".

## Full API

The [SDK README](https://github.com/tryaura/aura/tree/main/packages/sdk) carries the complete type
surface and a worked example plugin that is compiled as a type test.
