---
title: Plugins
description: Contribution slots available to an Aura plugin and the rules the registry enforces.
---

A plugin is created with `definePlugin` and declares an `id`, a `name`, a `version`, and
`apiVersion: 1`. Aura v1 loads only plugins declaring `apiVersion: 1`; anything else is rejected at
registration.

## Contribution slots

Every slot is optional.

| Slot           | Purpose                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| `adapters`     | Detect an agent application, declare files for core to read, parse contents into a normalized snapshot. |
| `checks`       | Synchronously inspect the `WorkspaceModel` and optionally return a `FixPlan`.                           |
| `snippets`     | Reference Markdown files.                                                                               |
| `skills`       | Reference skill directories.                                                                            |
| `skillSources` | Build-time drivers that list and resolve external skills.                                               |
| `mcpCatalog`   | Reference JSON MCP catalog entries.                                                                     |
| `presets`      | Reference JSON preset definitions.                                                                      |

## Namespacing

Every contribution `id` must be namespaced under the plugin's own `id`. Plugin `acme` contributes
`acme/rules`, never `rules`. The registry validates versions, IDs, collisions, and referenced
content before any of it is used.

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

## Full API

The [SDK README](https://github.com/tryaura/aura/tree/main/packages/sdk) carries the complete type
surface and a worked example plugin that is compiled as a type test.
