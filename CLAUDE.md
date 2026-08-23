# Aura — agent rules

Read [CONTRIBUTING.md](CONTRIBUTING.md) for detail. The non-negotiables:

- **Verify before done:** `pnpm verify` (typecheck → build → lint → format:check → knip → fallow
  → test) must pass. pnpm only — never npm or yarn. Bun is needed only for `verify:binary`.
- **Environment invariant:** never use `process.env`, `process.cwd`, `process.platform`,
  `process.argv`, `Date.now`, bare `Date`, or `os.homedir`/`tmpdir`/`hostname`/`userInfo` in
  product code. Use the injected `Environment` (`packages/sdk/src/environment.ts`): `cwd`,
  `homeDir`, `platform`, `pathEntries`, `now()`, `exec()`. Do not add lint suppressions to route
  around the ban.
- **300-line cap** per source file, blanks and comments included. Split files; don't suppress.
- **`docs/cli-ux.md` is a binding contract.** Any change to help screens, glyphs, or wizard
  behavior updates that document, the implementation, and the pinned inline snapshots together.
- **Layering:** `packages/testkit` depends on the CLI, so `packages/cli` must never import it —
  CLI tests use local fixtures.
- **Versioning:** `0.0.0` = private/unpublished; the publishable trio (sdk, cli, testkit) stays
  in lockstep at `0.5.3`.
- **PRs:** conventional-commit title; the title becomes the squash commit subject.
- Never name the tool configured under `.conductor/` in product source or docs, and never
  reference the maintainer's issue tracker (names or issue ids) anywhere in the repo.
