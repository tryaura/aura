---
title: Installation
description: Install the Aura CLI with the install script, npm, or a prebuilt binary.
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
