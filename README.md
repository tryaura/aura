# Aura

**Agent Unification & Repair Assistant** — every coding agent in your repo, working from the same
rules.

Claude Code, Codex, and Cursor each keep their own instruction files, their own MCP server list,
and their own idea of which skills are installed. Nothing keeps them in agreement. Aura reads all
of them, normalizes what it finds into a single workspace model, and reports where they have
drifted apart.

Docs: [tryaura.sh/docs/introduction](https://tryaura.sh/docs/introduction)

## Status

Pre-release. Core, the CLI shell, and the plugin SDK are in place. The Aura distribution ships
Claude Code, Codex, and Cursor adapters plus the `ENV-001` through `ENV-004` environment checks.
Content plugins remain under development. Every package is at `0.0.0` and nothing is published yet.

## How a scan works

1. **Adapters detect** which agent applications are installed and declare the files they care
   about. They do not read those files themselves.
2. **Core reads** the declared paths and hands the contents back to each adapter's `parse`, which
   is synchronous and has no filesystem access.
3. **Checks inspect** the resulting `WorkspaceModel` — every application's instruction documents,
   MCP servers, and skills together — and emit findings.
4. **Fixes return data**, never actions. A fix produces a `FixPlan` of write, remove, move, and
   symlink operations, so Aura can show a diff, dry run it, back it up, and undo it.

That separation is what makes a scan previewable. A check cannot run a command, and a fix cannot
make a network request.

## Install

```sh
curl -fsSL https://tryaura.sh/install | sh
```

The script detects your platform, verifies the release archive against the published `SHA256SUMS`,
and installs to `~/.aura/bin`. With Node.js 24 or newer, `npm install -g @tryaura/aura-cli` is the
shorter path. See [Installation](https://tryaura.sh/docs/installation) for prebuilt binaries and
the `AURA_INSTALL_DIR` / `AURA_VERSION` options.

## Usage

```sh
aura check              # inspect the current AI agent setup
aura check --json       # machine-readable report
aura check --detail     # include the failing plugin's own error text
aura check --explain ENV-003 # explain one check without scanning the machine
```

| Flag        | Purpose                                                                         |
| ----------- | ------------------------------------------------------------------------------- |
| `--json`    | Emit JSON on a stream separate from plugin output. Also applies to `--explain`. |
| `--detail`  | Include a failing plugin's error text. May contain file contents.               |
| `--explain` | Explain a check by ID without scanning adapters or repository state.            |
| `--home`    | Override the home directory. Must be absolute.                                  |
| `--path`    | Override the executable search path. Must list absolute directories.            |

Checks report what they find; nothing applies fixes yet. `--explain` states both what a check is
capable of fixing and that this build cannot apply it.

Exit codes are stable enough to gate CI on:

| Code | Meaning                                                             |
| ---- | ------------------------------------------------------------------- |
| `0`  | Clean — every check passed.                                         |
| `1`  | Warnings only.                                                      |
| `2`  | Errors, a scan or check diagnostic, or no checks registered at all. |

## Repository layout

| Path               | Contents                                                                  |
| ------------------ | ------------------------------------------------------------------------- |
| `packages/sdk`     | `@tryaura/aura-sdk` — the public plugin API. No runtime dependencies.     |
| `packages/core`    | Environment, workspace model, checks, fix-plan execution, managed blocks. |
| `packages/cli`     | `runCli(distro)` — the command shell a distribution is built on.          |
| `packages/testkit` | Integration helpers used across package test suites.                      |
| `plugins/*`        | Adapters (Claude Code, Codex, Cursor), core checks, official content.     |
| `distros/aura`     | The `aura` binary: branding plus the plugin list, composed at build time. |
| `apps/web`         | Marketing landing and Starlight docs, deployed on Cloudflare Workers.     |

A _distribution_ is the composition point: it picks branding and a build-time list of plugins and
calls `runCli`. Everything else is a library.

## Development

Requires Node.js 24 (see `.nvmrc`) and pnpm. Building the standalone executable also requires the
Bun version pinned in `.bun-version`.

```sh
pnpm install
pnpm verify
pnpm verify:binary
```

`verify` covers typecheck, build, lint, format check, knip, fallow, and tests. The individual
scripts are also available — `pnpm typecheck`, `pnpm build`, `pnpm lint`, `pnpm format` (`oxfmt`),
`pnpm knip`, `pnpm fallow`, `pnpm test`. `pnpm verify:binary` compiles the current-platform
executable and runs the seed-backed smoke suite against it; it is separate because it is the one
step that needs Bun. PR CI runs `verify`; the release workflow runs `verify:binary` on every
platform it ships to.

### A note on the compiled executable

Setting `BUN_BE_BUN=1` in the environment of a compiled Bun executable makes it behave as the Bun
CLI rather than as the program it was built from, which means anyone who can set environment
variables on an `aura` invocation can run arbitrary code through it. Compilation disables the
`.env` and `bunfig.toml` autoloading that would let a checked-in file reach that switch, but the
ambient variable is read before any Aura code runs and Bun offers no way to compile it out. Treat
the executable as trusted only as far as its environment is: do not rely on it as a boundary in a
context where an untrusted party controls the environment. `binary.smoke.ts` pins the behaviour so
that a future Bun release offering an opt-out is noticed.

## Writing a plugin

Everything Aura does ships as a plugin: adapters, checks, snippets, skills, skill sources, MCP
catalog entries, and presets are all contribution slots on `definePlugin`. Start with the
[SDK README](packages/sdk/README.md), which covers the API surface, the content-reference rules,
and the model invariants a plugin has to respect.

> **Plugins are not sandboxed.** A plugin runs with the full privileges of the Aura process.
> `Adapter.detect` and skill sources receive an `Environment` and can execute commands. Install
> plugins with the same care you apply to any other dependency. The declarative shapes in the SDK
> exist for previewability, not isolation — see the
> [trust model](packages/sdk/README.md#trust-model) for what Aura does enforce.

## License

[Apache-2.0](LICENSE).
