# `@tryaura/aura-cli`

Composable CLI runtime for Aura distributions. The package exports `runCli` from its root and the
official plugin composition from `@tryaura/aura-cli/plugins`. Installing it globally also provides
the official `aura` command.

The packages are prepared at `0.1.0` but are not published to npm yet. Until the first release,
use the repository's `pnpm verify:packages` command to build and exercise local tarballs.

See the [distro authoring guide](https://tryaura.sh/docs/guides/distributions) for branding, plugin
composition, distribution defaults, bundled runtime presets, compiled binaries, and testkit usage.
