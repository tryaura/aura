---
title: Installation
description: Install Aura from the install script, npm, or a prebuilt binary.
---

## Install script

```sh
curl -fsSL https://tryaura.sh/install | sh
```

This detects your platform, downloads the matching binary from
[GitHub Releases](https://github.com/tryaura/aura/releases), verifies its SHA-256 checksum against
the published `SHA256SUMS`, and installs to `~/.aura/bin`.

### If you would rather not pipe to a shell

Reading a script before running it is a reasonable habit, and the install script is written to be
read:

```sh
curl -fsSL https://tryaura.sh/install -o install.sh
less install.sh
sh install.sh
```

### Options

Both are environment variables:

| Variable           | Default        | Purpose                                       |
| ------------------ | -------------- | --------------------------------------------- |
| `AURA_INSTALL_DIR` | `~/.aura/bin`  | Where the binary is written.                  |
| `AURA_VERSION`     | latest release | Install a specific tag, for example `v0.2.0`. |

```sh
AURA_INSTALL_DIR=/usr/local/bin AURA_VERSION=v0.2.0 curl -fsSL https://tryaura.sh/install | sh
```

## npm

If you already have Node.js 24 or newer, this is the shorter path and keeps Aura updatable
alongside your other global tooling:

```sh
npm install -g @tryaura/aura-cli
```

## Prebuilt binaries

Every release publishes archives and a `SHA256SUMS` file for:

- `darwin-arm64`, `darwin-x64`
- `linux-arm64`, `linux-x64`

Download from the [releases page](https://github.com/tryaura/aura/releases) and verify:

```sh
shasum -a 256 -c SHA256SUMS --ignore-missing
```

## Verify the install

```sh
aura --version
```

If your shell cannot find `aura`, add the install directory to your `PATH`:

```sh
export PATH="$HOME/.aura/bin:$PATH"
```

The install script prints the exact line to add for your shell.

## Local-tarball walkthrough

To exercise an unreleased change without touching a registry, from an Aura checkout run:

```sh
pnpm install --frozen-lockfile
pnpm verify:packages
```

This builds and packs `@tryaura/aura-sdk`, `@tryaura/aura-cli`, and
`@tryaura/aura-testkit`; validates their contents; installs only those tarballs into a
temporary consumer with an isolated pnpm store; typechecks a plugin and branded distribution;
checks the installed `aura --version`; and compiles and executes the distribution with Bun. It
does not publish, authenticate to, or modify an npm registry.

## Run the environment doctor

From a repository, run:

```sh
aura check
```

The current distribution includes these environment, instruction, and managed-content checks:

| ID        | What it verifies                                                  |
| --------- | ----------------------------------------------------------------- |
| `ENV-001` | Agent applications use supported versions.                        |
| `ENV-002` | Agent applications are authenticated.                             |
| `ENV-003` | Repository ignore rules separate personal and shared agent state. |
| `ENV-004` | Agent settings allow the current project to run normally.         |
| `INS-001` | Shared instructions exist.                                        |
| `INS-002` | Agent applications load shared instructions.                      |
| `INS-003` | Instruction guidance is not duplicated.                           |
| `INS-004` | Legacy instruction files are consolidated.                        |
| `INS-005` | Instruction guidance does not contradict itself.                  |
| `INS-006` | Instruction links are valid and supported.                        |
| `INS-007` | Instruction context stays within a practical budget.              |
| `INS-008` | Instruction guidance respects global and project precedence.      |
| `MGD-001` | Aura-managed instruction blocks have not changed by hand.         |
| `MGD-002` | Newer unpinned managed snippet and skill revisions are available. |
| `MGD-003` | A detected application has not been managed or ignored.           |

MGD-002 and MGD-003 findings are informational and remain green. Every completed check exits with
exit status `0`, including checks with warning or error findings; use report status or severity
counts to gate automation on findings. Use `aura check --fix` to review an MGD-002 update or
removal plan; MGD-003 points to `aura setup` and never starts a nested command.

To read why a check exists without scanning applications or repository state, use:

```sh
aura check --explain ENV-003
```

Use `--json` for a machine-readable report, or with `--explain` for a machine-readable explanation.
`--detail` includes the underlying text for a scan diagnostic, and cannot be combined with
`--explain`, which never scans.

Checks that declare fixes can also apply them. `aura check --fix` walks the guided resolutions,
previews the combined plan, and applies it after one confirmation. `--fix --dry-run` prepares and
previews the same plan without confirming or writing; `--fix --yes` applies the automatic fixes
without confirmation, and names the guided ones it left for a run that can ask. `--explain` states
whether a given check can be fixed automatically.
