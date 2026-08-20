---
title: Plugins
description: Contribution slots available to an Aura plugin and the rules the registry enforces.
---

A plugin is created with `definePlugin` and declares an `id`, a `name`, a `version`, and
`apiVersion: 1`. Aura v1 loads only plugins declaring `apiVersion: 1`; anything else is rejected at
registration.

## Contribution slots

Every slot is optional.

| Slot                           | Purpose                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `adapters`                     | Detect an agent application, declare files for core to read, parse contents into a normalized snapshot. |
| `checks`                       | Synchronously inspect the `WorkspaceModel` and optionally return a `FixPlan`.                           |
| `disabledSkillSources`         | Remove exact bundled, directory, or driver source IDs when those sources are present.                   |
| `snippets`                     | Reference Markdown fragments users can append once to shared instructions.                              |
| `skills`                       | Reference skill directories.                                                                            |
| `skillDirectories`             | Remote directories served through Aura's bounded HTTP client or a built-in provider adapter.            |
| `skillSources`                 | Lazy drivers that list and resolve non-standard external skills during interactive setup.               |
| [`mcpCatalog`](./mcp-catalog/) | Reference JSON MCP catalog entries.                                                                     |
| [`presets`](./team-preset/)    | Reference JSON preset definitions.                                                                      |

Public `skillDirectories` use Aura's `index.json` and `skills/<id>` protocol by default. A
distribution may set `protocol: "agenticskills"` on a registered public directory to translate
AgenticSkills' metadata feed and exact GitHub skill directories into the same bounded, reviewed
install flow. Team presets remain data-only and use the native protocol.

Each driver ID becomes `driver:<namespaced-id>` in presets and manifests. Aura calls `list` once
when interactive setup opens Skills, groups selected IDs into one `resolve` call per driver, and
caches both results for the run. Neither method is called during a workspace scan, a check run, or
`setup --yes`. A resolved pack references an absolute local `file:` directory and carries a
credential-free origin URL. Aura reads the tree, enforces file, path, count, size, and encoding
limits, computes its hash, and requires `SKILL.md`. Failures are isolated by source and skill; raw
errors and returned bytes are never diagnostics.

A driver runs your code, so it is trusted like the distribution that compiled it — which is also
why it is never handed a credential the way a private directory is. Aura bounds only its own wait:
a `list` or `resolve` that has not returned within 30 seconds is treated as unavailable. Because the
protocol has no cancellation, the call itself keeps running, so a driver that may take longer than
that should cache its work rather than expect Aura to block on it.

The origin URL a driver returns is a claim about where the content came from, not a URL Aura
fetched. It is shown at the review attributed to the driver. Return the address a reader could
actually audit the content at.

`disabledSkillSources` is additive across loaded plugins and applied after every plugin has loaded,
so it does not depend on plugin order. A matching registered source is omitted and reported at setup
as a note naming your plugin; an absent target is a no-op. A disabled source still reserves its ID,
so removing one can never let a colliding contribution through. Existing manifest selections remain
unavailable rather than being automatically removed.

## Namespacing

Checks, snippets, MCP catalog entries, presets, and skill-source drivers are normally namespaced
under the plugin's own ID. Plugin `acme` contributes `acme/rules`, never `rules`. Adapter IDs are
global application identities such as `claude-code`, and skill-directory IDs are global source
identities such as `agenticskills`; neither uses the plugin prefix. Bundled skill IDs are local to
their source, so `review` from `plugin:acme` and `review` from another source can coexist in the
catalog. The registry validates versions, IDs, and composite source/skill collisions.

Bare check IDs are the one privilege a distribution can grant. Name the plugin in the registry's
`bareCheckIdPlugins` option and its checks may contribute unprefixed IDs such as `ENV-001`:

```ts
createPluginRegistry(plugins, { bareCheckIdPlugins: ["checks-core"] });
```

The list is validated against the loaded plugins, so a typo fails at boot rather than silently
granting nothing. Reserve it for the checks your distribution presents as its own stable surface;
everything else stays namespaced. See the [distributions guide](/docs/guides/distributions/) for
where this is wired up.

## Content references

Content references must be absolute `file:` URLs, constructed relative to the plugin module:

```ts
const url = new URL("./content/preset.json", import.meta.url).href;
```

Working-directory-relative paths do not work. The registry validates declared shapes — IDs,
semver versions, the API version, and shared-link declarations — but it does not open content
URLs. Snippet sources are read lazily when setup opens the snippet picker; unreadable or oversized
content becomes a disabled row. Other content sources are not read until the contribution is used.

Installing a snippet appends its Markdown without markers and records its ID plus a content hash.
Later setup runs show that ID as installed in an enabled, ticked row so users can clear the record;
Aura never updates, removes, or pins the text. The hash only lets setup note that the source changed
or that the installed text is missing. The `version` field remains required canonical semver
metadata for the contribution but is not stored in the manifest after installation.

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
