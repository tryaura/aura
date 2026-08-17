# Contributing to Aura

## Toolchain

- **Node.js 24** — pinned in `.nvmrc`; every package declares `engines.node >= 24`.
- **pnpm 11.21.0** — pinned in the root `package.json` `packageManager` field. Use pnpm only
  (`corepack enable` activates the pinned version); npm and yarn will drift the lockfile.
- **Bun 1.3.14** — pinned in `.bun-version`. Needed only to compile the standalone executable:
  `distros/aura` uses `bun build --compile` in `build:binary`/`verify:binary`, and
  `scripts/verify-packages.mjs` compiles its clean-room distro with Bun (falling back to
  `pnpm dlx bun@<pin>` when Bun is not installed). Everything else runs on Node.
- **TypeScript is pinned twice on purpose.** The root pins `typescript` 7.0.2 for all package
  typechecks; `apps/web` pins its own `typescript` 6.0.3 because `astro check` runs the compiler
  version it supports. Bump them independently.

## Verify

`pnpm verify` is the gate for every change. It runs, in order:

| Gate           | Command             | What it catches                                                                                                                                                                                        |
| -------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `typecheck`    | `pnpm -r typecheck` | Type errors per package (`tsc --noEmit`), plus the `type-tests/` projects in `packages/sdk` and `packages/cli`. Commonly fails after changing a public type in one package without updating consumers. |
| `build`        | `pnpm -r build`     | Compilation of every package (`tsc`/`tsdown`). Runs before `test` so tests exercise real `dist` output.                                                                                                |
| `lint`         | `oxlint .`          | Correctness rules as errors, plus repo policy: the 300-line cap and the restricted-globals/imports bans behind the Environment invariant (below). Warnings are denied.                                 |
| `format:check` | `oxfmt --check`     | Formatting drift; `pnpm format` fixes it.                                                                                                                                                              |
| `knip`         | `knip`              | Unused files, exports, and dependencies (`knip.json`).                                                                                                                                                 |
| `fallow`       | `fallow audit`      | Architecture and dead-surface rules from `.fallowrc.json`. CI gates on new findings only, diffed against `FALLOW_AUDIT_BASE`.                                                                          |
| `test`         | `vitest run`        | The whole workspace's tests from the root `vitest.config.ts`. `dist` is excluded so built copies of tests are not collected twice.                                                                     |

`pnpm verify:binary` (requires Bun) compiles the current-platform executable and runs the
seed-backed smoke suite. `pnpm verify:packages` runs the clean-room packaging check described
under Releases.

## The Environment invariant

Product code never reads ambient process state. `.oxlintrc.json` bans `process.env`,
`process.cwd`, `process.platform`, `process.argv`, `Date.now`, the bare `Date` global, and
`os.homedir`/`hostname`/`tmpdir`/`userInfo` everywhere except the boot seam
(`packages/cli/src/run.ts`, `packages/core/src/environment.ts`), test files, and testkit seeding.

Use the `Environment` injected at boot instead — defined in `packages/sdk/src/environment.ts`:
`cwd`, `homeDir`, `platform`, `pathEntries`, `now()`, and `exec()`. `new Date(value)` is fine only
where `value` comes from data. This is what lets the testkit seed a fake HOME, `PATH`, and clock
and get byte-stable output; a direct `process.env` read punches a hole in that determinism. Do not
add lint suppressions or new override entries to route around it.

## The 300-line cap

Every source file is capped at 300 lines, blank lines and comments included (`max-lines` in
`.oxlintrc.json`). Split the file rather than suppressing the rule.

## The CLI UX contract

`docs/cli-ux.md` is binding, not descriptive. The renderers in `packages/cli/src/help.ts` and
`packages/cli/src/setup/wizard-render.ts` implement it, and inline snapshots pin the exact bytes.
Any change to help screens, glyphs, or wizard behavior updates the document, the implementation,
and the snapshots together.

## Tests

- Tests are co-located `*.test.ts` files, collected workspace-wide by the root
  `vitest.config.ts`. Run them with `pnpm test`; `pnpm test:coverage` adds a report-only V8
  coverage report (no thresholds, not part of `verify`).
- **Layering rule:** `packages/testkit` depends on `@tryaura/aura-cli`, so it sits _above_ the
  CLI. `distros/aura` and `scripts/fixtures` consume it; `packages/cli` must not — CLI tests use
  local fixtures instead. Importing the testkit from `packages/cli` would create a cycle.
- Binary smoke tests live in `distros/aura/src/*.smoke.ts` and run against the compiled Bun
  executable via `pnpm verify:binary`.

## Releases and versioning

- `0.0.0` marks a private, unpublished package. The publishable trio — `@tryaura/aura-sdk`,
  `@tryaura/aura-cli`, `@tryaura/aura-testkit` — sits at `0.1.0` and is kept in lockstep;
  `scripts/verify-packages.mjs` asserts every public manifest against the SDK's version.
- `pnpm verify:packages` is the clean-room check: it packs the trio, validates tarball contents
  and manifests (no install hooks, no private-dependency leaks), installs only those tarballs into
  an isolated consumer, typechecks it, and compiles and runs a branded distro with Bun.
- Pushing a `v*` tag triggers `.github/workflows/release.yml`: a full `verify` job gates
  per-target builds (linux/darwin × x64/arm64), each of which stamps the tag version into
  `distros/aura`, compiles and smoke-tests the binary (`verify:binary`), and packages it with the
  `LICENSE`. Checksummed tarballs are attached to the GitHub release.
- Because the version is stamped only in release CI, a source build's `aura --version` reports
  `0.0.0`.

## Pull requests

- Commits and PR titles follow conventional commits (`feat(cli): …`, `fix(checks): …`).
- The PR title becomes the squash commit subject.
- Run `pnpm verify` before requesting review.

## One more rule

The maintainer's local orchestration tool is configured under `.conductor/`. Never name it in
product source or docs; references belong only inside `.conductor/` itself and its own
configuration lines.
