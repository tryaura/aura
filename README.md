# Aura

**Agent Unification & Repair Assistant** — keep Claude Code, Codex, and Cursor working from the
same instructions.

Each coding agent keeps its own instruction files and MCP configuration. Aura detects the agents
available on a machine, reads their configuration into one workspace model, reports drift, and can
converge the files it manages through a previewable fix plan.

Docs: [tryaura.sh/docs/introduction](https://tryaura.sh/docs/introduction)

## Run from source

Aura requires Node.js 24 and pnpm 11. The versions are pinned in `.nvmrc` and the root
`package.json`.

```sh
corepack enable
pnpm install
pnpm build
node distros/aura/dist/main.js --help
```

Use the built entry point for a first, read-only scan:

```sh
node distros/aura/dist/main.js check
```

To build the standalone executable, install the Bun version pinned in `.bun-version`, then run:

```sh
pnpm --filter @tryaura/aura build:binary
./distros/aura/dist/aura --help
```

The examples below use `aura` for readability; from a source checkout, substitute either built
entry point above.

## Setup

Preview setup before allowing it to write:

```sh
aura setup --dry-run
aura setup
```

The wizard:

1. detects Claude Code, Codex, and Cursor and asks which applications Aura should manage;
2. creates or consolidates global and project instructions, with optional archival of originals;
3. offers the seven bundled snippets for Git, safety, Atlassian, TypeScript, and Python guidance;
4. records desired state and ownership in `~/agents/aura.json`; and
5. previews one combined plan, asks once, applies it atomically, then rescans the machine.

Setup is convergent: rerunning it with the same selections produces no changes. `--yes` accepts
the least-invasive defaults without prompts, while `--detail` includes full file diffs and may
therefore expose instruction contents.

```sh
aura setup --yes
aura setup --detail
```

After the full setup has created the shared instruction file, reopen only the snippet picker with:

```sh
aura setup --add snippet
```

The shortcut still previews and applies one atomic plan and finishes by running the checks. It
skips application selection, instruction consolidation, and baseline questions. An unchanged run
prints `Already converged — nothing to do.` and does not rewrite the manifest or create a backup.

An unchanged run is the one exception away from being a no-op: the manifest records which
applications Aura manages, so it is held at mode `600`, and any run rewrites it when its
permissions have been widened even if its contents already match.

Successful writes receive a backup ID and failed applications are rolled back when possible. `aura
undo` restores the most recent backup, or a named one, after one confirmation. Stopping
management of an application updates the manifest but deliberately leaves its existing agent
configuration in place.

```sh
aura undo --list                        # list every backup and its status
aura undo                               # restore the newest backup after one confirmation
aura undo 2026-08-16T23-47-43-937Z      # restore one backup by name
aura undo --dry-run                     # name what would be restored, write nothing
```

## Check and repair

```sh
aura check                              # inspect the current agent setup
aura check --json                       # emit the versioned JSON report
aura check --only ENV --only claude     # run environment checks for Claude Code
aura check --detail                     # include plugin diagnostics and fix diffs
aura check --explain ENV-003             # explain one check without scanning
aura check --fix --dry-run               # preview automatic fixes without writing
aura check --fix                         # preview, confirm, and apply automatic fixes
aura check --fix --interactive           # include guided remediation choices
```

The bundled checks cover:

| IDs           | What they inspect                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| `ENV-001–004` | Supported app versions, authentication, repository ignore policy, and restrictive project settings.    |
| `INS-001–008` | Shared links, duplicate or contradictory guidance, legacy files, link integrity, size, and precedence. |
| `MGD-001`     | Hand edits inside Aura-managed instruction blocks.                                                     |

### Check flags

| Flag             | Purpose                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `--only`         | Select a check ID, category, or canonical application ID. Repeat to union selectors.             |
| `--json`         | Emit JSON on a stream separate from prompts and progress. Also applies to `--explain`.           |
| `--json-version` | Select the JSON contract version; version `1` is supported and remains the default.              |
| `--detail`       | Include diagnostic detail and fix diffs. May contain file contents.                              |
| `--explain`      | Explain a check by ID without scanning adapters or repository state.                             |
| `--fix`          | Preview automatic fixes and apply them after one confirmation.                                   |
| `--interactive`  | With `--fix`, choose guided remediations before the combined preview. Requires terminal prompts. |
| `--dry-run`      | With `--fix`, prepare and preview the same plan without confirming or writing.                   |
| `--yes`          | With `--fix`, apply automatic fixes without confirmation.                                        |
| `--home`         | Override the home directory. Must be absolute.                                                   |
| `--path`         | Override the executable search path. Must list absolute directories.                             |

The versioned JSON contract and published schema are documented in the
[check JSON reference](https://tryaura.sh/docs/reference/check-json/).

`--only` matches case-insensitive exact check IDs first, then check categories and real adapter
IDs. Categories are the local ID prefix, such as `ENV` in `ENV-003`. `claude` and `claude_code`
are aliases for the canonical `claude-code` adapter ID. Repeated selectors are ORed within the
check and application dimensions, then those dimensions are intersected.

Check exit codes are stable enough to gate CI on:

| Code | Meaning                                                                                       |
| ---- | --------------------------------------------------------------------------------------------- |
| `0`  | Clean, or informational findings only.                                                        |
| `1`  | Warning findings.                                                                             |
| `2`  | Error findings, invalid usage or selectors, filesystem conflicts, or an empty check registry. |
| `3`  | Adapter, check, plugin, registry, command, or fix preparation/application failures.           |

## How a scan works

1. **Adapters detect** installed agent applications and declare the files they need. They do not
   read those files themselves.
2. **Core reads** the declared paths and passes bounded contents to each adapter's synchronous
   `parse` function.
3. **Checks inspect** the normalized `WorkspaceModel` and emit findings without reading the
   filesystem or process environment.
4. **Fixes return data**, never actions. A fix produces a `FixPlan` of write, remove, move,
   archive, and symlink operations for Aura to preview and apply through its fix-plan kernel.

That separation makes every change previewable. A check cannot run a command, and a fix cannot
make a network request. Fix plans use target locking, precondition checks, atomic replacement,
backup journals, and rollback on failure.

## Development

Building the standalone executable requires the Bun version pinned in `.bun-version`; the rest of
the repository uses Node.js 24 and pnpm.

```sh
pnpm install
pnpm verify
pnpm verify:binary
```

`verify` runs typecheck, build, lint, format check, knip, fallow, and tests. The individual scripts
are also available: `pnpm typecheck`, `pnpm build`, `pnpm lint`, `pnpm format`, `pnpm knip`,
`pnpm fallow`, and `pnpm test`. `verify:binary` compiles the current-platform executable and runs
the seed-backed smoke suite; it is separate because it requires Bun. Pull-request CI runs
`verify`, while tagged releases run the binary suite on macOS and Linux for arm64 and x64.

### Compiled executable trust boundary

Setting `BUN_BE_BUN=1` in a compiled Bun executable's environment makes it behave as the Bun CLI
rather than the program it was built from. Compilation disables `.env` and `bunfig.toml`
autoloading, but Bun reads the ambient variable before Aura starts. Treat the executable as trusted
only as far as its environment; do not use it as a security boundary when an untrusted party can
set environment variables. The binary smoke suite pins this behavior so a future Bun opt-out is
noticed.

## Writing a plugin

Everything Aura does ships as a plugin. Adapters, checks, snippets, skills, skill sources, MCP
catalog entries, and presets are contribution slots on `definePlugin`. Start with the
[SDK README](packages/sdk/README.md), which covers the API, content-reference rules, and model
invariants.

> **Plugins are not sandboxed.** A plugin runs with the full privileges of the Aura process.
> `Adapter.detect` and skill sources receive an `Environment` and can execute commands. Install
> plugins with the same care you apply to any other dependency. The declarative SDK shapes exist
> for previewability, not isolation; see the
> [trust model](packages/sdk/README.md#trust-model) for the guarantees Aura does enforce.

## License

[Apache-2.0](LICENSE).
