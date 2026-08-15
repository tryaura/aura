# Sourced by every Conductor script in .conductor/settings.toml — not executed directly.
#
# Conductor runs setup and run scripts in non-interactive shells (zsh on macOS, bash in cloud
# workspaces), which never load the fnm shim that normally puts the pinned Node and pnpm on PATH.
# Without this bootstrap, `pnpm` is simply not found and every script fails on a fresh workspace.
#
# Safe to source repeatedly; every step is guarded.

# shellcheck shell=sh

if ! command -v fnm >/dev/null 2>&1; then
  for _dir in /opt/homebrew/bin /usr/local/bin "$HOME/.local/share/fnm" "$HOME/.fnm"; do
    if [ -x "$_dir/fnm" ]; then
      PATH="$_dir:$PATH"
      export PATH
      break
    fi
  done
  unset _dir
fi

# Selects the version in .nvmrc, installing it on a machine that does not have it yet.
if command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env)"
  fnm use --install-if-missing >/dev/null
fi

# The repo pins pnpm through package.json#packageManager, which corepack resolves.
if ! command -v pnpm >/dev/null 2>&1 && command -v corepack >/dev/null 2>&1; then
  corepack enable pnpm >/dev/null 2>&1 || true
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm not found." >&2
  echo "Install Node $(cat .nvmrc 2>/dev/null || echo 24) and run 'corepack enable pnpm'." >&2
  return 1 2>/dev/null || exit 1
fi
