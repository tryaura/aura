# Acme distribution example

This is a complete private Aura distribution. It adds:

- an adapter for an internal `acme-agent` CLI;
- an Acme engineering instruction snippet;
- an `acme-release` Agent Skill; and
- a credential-safe Acme source-control MCP catalog entry.

The repository's `pnpm verify:packages` command copies this project into a clean directory,
installs only locally packed public Aura packages, typechecks it, compiles a Linux binary in CI,
and runs `smoke.mjs` against that binary.

The Aura packages are release candidates and are not published yet, so use the repository-level
verification command for now:

```sh
pnpm verify:packages
```

After the packages are published, install the example's dependencies, copy the official CLI
snippet assets from `node_modules/@tryaura/aura-cli/content` into `content`, and run:

```sh
pnpm verify
```

See the [internal distribution guide](../../apps/web/src/content/docs/docs/guides/internal-distribution.md)
for a step-by-step explanation of every file.
