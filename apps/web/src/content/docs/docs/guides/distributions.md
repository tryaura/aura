---
title: Author a distribution
description: Compose, brand, test, and compile a private Aura distribution.
---

An Aura distribution is a small executable that chooses branding and a build-time plugin list around `runCli`. It does not discover plugins from an end user's machine.

For a complete private-plugin example that bundles an internal agent adapter, snippets, skills,
and MCP definitions, follow
[Build an internal distribution](/docs/guides/internal-distribution/).

> The three packages are published to npm and released in lockstep. Pin all of them to the same version.

## Set up the project

Use Node.js 24, pnpm, TypeScript, and Bun 1.3.14. Add `@tryaura/aura-cli`, `@tryaura/aura-sdk`, and `@tryaura/aura-testkit` at the same version.

To try an unreleased change, replace the versions with `file:` paths to all three locally packed tarballs and add pnpm overrides for the same names. This makes transitive CLI and SDK references resolve to tarballs without contacting a registry. `pnpm verify:packages` performs this exact isolated-store walkthrough.

## Compose the executable

```ts
#!/usr/bin/env node
import { runCli, type CliDistro } from "@tryaura/aura-cli";
import { OFFICIAL_PLUGINS, OFFICIAL_REGISTRY_OPTIONS } from "@tryaura/aura-cli/plugins";
import acmePlugin from "@acme/aura-plugin";

const distro: CliDistro = {
  branding: {
    command: "acmedev",
    displayName: "Acme Dev",
    description: "Acme's agent configuration doctor",
    docsUrl: "https://engineering.acme.example/acmedev",
    version: "0.1.0",
  },
  defaultPreset: "plugin:acme/platform",
  defaults: {
    checks: { severity: { "acme/SEC-001": "error" } },
  },
  plugins: [...OFFICIAL_PLUGINS, acmePlugin],
  registry: OFFICIAL_REGISTRY_OPTIONS,
};

await runCli(distro);
```

Every branding field has one job:

- `command`: executable name printed in usage.
- `displayName`: product name in human-readable output.
- `description`: optional top-level help text.
- `docsUrl`: optional report documentation link.
- `version`: optional value returned by `--version`.

`defaults` is the lowest runtime configuration layer. `defaultPreset` selects a preset bundled by
a registered plugin when neither the CLI, manifest, nor repository chooses one. Both are data-only;
see the [team preset reference](/docs/reference/team-preset/) for the schema and precedence rules.

The frozen official values match the `aura` executable. Named official plugin exports support explicit subsets. Registry privileges belong to the distribution; do not grant private plugins bare check IDs unless you own that compatibility surface.

## Write an SDK plugin

```ts
import { defineCheck, definePlugin } from "@tryaura/aura-sdk";

const configured = defineCheck({
  defaultSeverity: "warn",
  detect: () => [{ id: "configured", message: "The Acme plugin loaded." }],
  explain: "Confirms the distro loaded its private policy package.",
  fixability: "manual",
  id: "acme/ACME-001",
  scope: "global",
  title: "Acme policy loads",
});

export default definePlugin({
  apiVersion: 1,
  checks: [configured],
  id: "acme",
  name: "Acme policy",
  version: "1.0.0",
});
```

Aura v1 accepts only `apiVersion: 1`. Namespace contributions under the plugin ID. Plugins run with the executable's full privileges, so distribute and review them as trusted dependencies.

For a private registry, publish under a scope such as `@acme/aura-plugin`, configure its token only in distribution CI, and install it into the distribution project. End users receive the compiled distro; they do not install plugins at runtime. Never place registry tokens in source, metadata, assets, or binaries.

## Send telemetry

By default a distribution sends nothing: with no sink composed, telemetry is a no-op. To measure how an organization's setups are doing, add a `TelemetrySink` to the distro:

```ts
import { createHttpTelemetrySink, type CliDistro } from "@tryaura/aura-cli";

const distro: CliDistro = {
  branding: { command: "acmedev", displayName: "Acme Dev" },
  plugins: [...OFFICIAL_PLUGINS],
  telemetry: createHttpTelemetrySink({
    url: "https://telemetry.acme.example/aura",
  }),
};
```

A compiled CLI cannot keep a bearer token or other embedded credential secret: anyone with the binary can extract it. Use an intentionally public, write-only ingestion endpoint protected by server-side validation, rate limits, and abuse controls, or acquire a narrowly scoped per-user credential at runtime. Never put a secret telemetry credential in source, metadata, assets, or the compiled binary.

Eligible commands emit one or more events: `check-run` (apps detected, per-check finding counts, passed check IDs, duration, exit code), an additional `fix-run` when fixing was requested, `setup-run` (how the run ended plus distribution-owned manifest metadata), and `undo-run`. Help, explanations, and usage rejections emit no event. Events are delivered together in one batched flush as the process exits.

Payloads contain distribution-owned IDs and versions, counts, booleans, and durations. They never contain file paths, file contents, finding messages, display names, environment values, detected application version strings, custom MCP server names, or externally sourced skill metadata. External skills and custom MCP servers are represented by counts.

A custom sink implements `TelemetrySink` from the SDK: `record(event)` must buffer and return immediately, and `flush(signal)` runs once at the end of the run under a bound of about two seconds. The sink must stop its I/O when `signal` aborts so undelivered work cannot keep the process open. Throws are swallowed, and nothing the sink does may write to the process streams. The built-in HTTP sink validates its configuration when created and accepts an `onDeliveryFailure` callback for privacy-safe operational monitoring.

The user always wins over the distribution: `DO_NOT_TRACK` (non-empty, other than `0`) or `AURA_TELEMETRY=off` in the invoking environment disables the sink before it sees a single event, and a distribution cannot override that.

## Keep the protocol stable

Branding can change presentation, not Aura's protocol. Retain:

- canonical shared instructions at `~/agents/AGENTS.md`;
- the manifest at `~/agents/aura.json`, schema version 1 and mode `0o600`;
- outer markers `<!-- aura:begin -->` and `<!-- aura:end -->`;
- snippet markers `<!-- aura:begin id=<id> sha256=<64 lowercase hex> -->` and `<!-- aura:end id=<id> -->`.

Do not rename paths, translate markers, or replace `aura` in marker syntax with the branded command.

## Test with deterministic seeds

```ts
import { runCheck, createSeedBuilder } from "@tryaura/aura-testkit";

await using seed = await createSeedBuilder()
  .homeFile("agents/AGENTS.md", "# Shared rules\n")
  .workspaceFile(".gitignore", "node_modules/\n")
  .build();

const result = await runCheck({ distro, seed });
```

Seeds isolate HOME, workspace, and PATH. Add `.shim(command, responses)`, inspect `seed.invocations(command)`, use `runSetup` for setup flows, and `runBinaryCheck` for compiled executables. Always dispose or clean up a seed.

## Compile with Bun

Stage the CLI tarball's `content` directory at `./content`, then embed its Markdown with stable paths:

```sh
bun build src/main.ts content/snippets/*.md \
  --compile \
  --loader .md:file \
  --asset-naming='content/snippets/[name].[ext]' \
  --no-compile-autoload-dotenv \
  --no-compile-autoload-bunfig \
  --outfile dist/acmedev
```

Run `dist/acmedev --version`, then exercise it with `runBinaryCheck`. `pnpm verify:packages` is the full clean-room reference: it packs the packages, installs only their tarballs, typechecks the plugin and distro, compiles with Bun, and proves the private check runs.
