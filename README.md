# Aura

**Agent Unification & Repair Assistant** — keep Claude Code, Codex, and Cursor working from the
same reviewed instructions, skills, and MCP servers.

Aura detects the coding-agent applications on a machine, reads their configuration into one model,
reports drift, and prepares previewable repairs. Setup and fixes use one file plan with conflict
checks, backups, rollback, and undo.

## Install and run

```sh
curl -fsSL https://tryaura.sh/install | sh
```

Then preview setup, apply it interactively, and verify the result:

```sh
aura setup --dry-run
aura setup
aura check
```

Start with the [Quickstart](https://tryaura.sh/docs/quickstart/) for expected output, failure paths,
and recovery. The [installation guide](https://tryaura.sh/docs/installation/) covers npm, pnpm,
release archives, updates, and uninstalling.

## Documentation

- [Set up and converge](https://tryaura.sh/docs/guides/setup/)
- [Understand and fix findings](https://tryaura.sh/docs/guides/check-and-fix/)
- [Manage snippets, skills, and MCP servers](https://tryaura.sh/docs/guides/managed-content/)
- [Share repository content](https://tryaura.sh/docs/guides/repository-content/)
- [Automatic updates](https://tryaura.sh/docs/guides/automatic-updates/)
- [Build a distribution](https://tryaura.sh/docs/guides/distributions/)
- [Ship a distribution](https://tryaura.sh/docs/guides/ship-a-distribution/)
- [Add distribution updates](https://tryaura.sh/docs/guides/distribution-updates/)
- [CLI reference](https://tryaura.sh/docs/reference/cli/)

Aura may inspect repository files for diagnostics, but setup, fixes, and undo do not modify the
current repository. Plugins are trusted code and are not sandboxed.

## Run from source

Aura requires Node.js 24 and pnpm 11. The versions are pinned in `.nvmrc` and the root
`package.json`; the repository uses Node.js 24 and pnpm. Bun is needed only for standalone binary
compilation.

```sh
corepack enable
pnpm install
pnpm build
node distros/aura/dist/main.js --help
node distros/aura/dist/main.js check
```

A source build reports `--version` as `0.0.0`; release CI stamps the tagged version. Build and test
the current-platform standalone executable with the Bun version pinned in `.bun-version`:

```sh
pnpm verify:binary
```

## Development

```sh
pnpm install
pnpm verify
```

`pnpm verify` runs workflow validation, typecheck, build, lint, format checking, architecture and
dead-code checks, and the full test suite. See [CONTRIBUTING.md](CONTRIBUTING.md) for repository
rules, release verification, and the injected `Environment` invariant.

## Repository layout

| Path                         | Purpose                                                             |
| ---------------------------- | ------------------------------------------------------------------- |
| `packages/sdk`               | Public plugin API and declarative model types.                      |
| `packages/core`              | Workspace discovery, presets, manifests, checks, and fix plans.     |
| `packages/cli`               | `runCli(distro)` and the setup, check, and undo command shell.      |
| `packages/testkit`           | Deterministic seeded machines and source/binary harnesses.          |
| `plugins/*`                  | Official application adapters, checks, and content.                 |
| `distros/aura`               | Branding and build-time plugin composition for the official binary. |
| `apps/web`                   | Marketing site and Starlight documentation.                         |
| `examples/acme-distribution` | Fully tested private distribution example.                          |

## Extend Aura

Everything Aura does is composed from plugins. The
[plugin reference](https://tryaura.sh/docs/reference/plugins/) explains contribution identities,
content URLs, and trusted-code boundaries. The public SDK README contains the full type surface and
a plugin example that is compiled as a type test.

## License

[Apache-2.0](LICENSE)
