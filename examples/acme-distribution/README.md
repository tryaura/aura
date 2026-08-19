# Acme distribution example

This is a complete private Aura distribution. It adds:

- an adapter for an internal `acme-agent` CLI;
- an Acme engineering instruction snippet;
- bundled `acme-release` and driver-provided `acme-review` Agent Skills;
- a credential-safe Acme source-control MCP catalog entry;
- a denylist removing the optional AgenticSkills directory; and
- a bundled `plugin:acme/platform` runtime preset demonstrating checks, required MCP, content, and
  skill-source policy.

It is a workspace member, so `pnpm typecheck` at the repository root covers it on every pull
request. Its dependencies are `workspace:*` for that reason; a real internal distribution pins
published versions instead.

`pnpm verify:packages` copies this project into a clean directory, re-resolves those three
dependencies to locally packed tarballs, typechecks it, compiles a binary, and runs `smoke.mjs`
against it. That command builds with `content-entrypoints.mjs`, the same module `build.mjs` uses,
so the binary CI verifies embeds exactly the files a local build embeds:

```sh
pnpm verify:packages
```

To build and smoke-test the binary in place, stage the official CLI snippet assets from
`node_modules/@tryaura/aura-cli/content` into `content/` first, then:

```sh
pnpm verify
```

See the [internal distribution guide](../../apps/web/src/content/docs/docs/guides/internal-distribution.md)
for a step-by-step explanation of every file.
