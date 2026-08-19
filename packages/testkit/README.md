# `@tryaura/aura-testkit`

Deterministic fake machines for testing Aura plugins and distributions. A test describes a HOME, a
workspace, and the executables on `PATH`; the testkit materializes them in a temporary directory,
runs the real CLI against them in process, and hands back output that is stable enough to snapshot.

Nothing in a seeded run reads the surrounding process — not the real home directory, not the real
`PATH`, and not the ambient environment. A secret in `process.env` is not visible to a command the
run spawns.

## Seeding a machine

```ts
import { createSeedBuilder, runCheck } from "@tryaura/aura-testkit";

it("runs a distribution against a fake machine", async () => {
  await using seed = await createSeedBuilder()
    .homeFile(".fixture/config.txt", "legacy=true\n")
    .workspaceFile("AGENTS.md", "workspace instructions\n")
    .shim("fixture-agent", [{ args: ["--version"], stdout: "fixture-agent 1.2.3\n" }])
    .build();

  const result = await runCheck({
    distro: {
      branding: { command: "fixture", displayName: "Fixture Doctor" },
      plugins: [],
    },
    seed,
  });

  expect(result.findings).toMatchInlineSnapshot();
});
```

`await using` disposes the seed at the end of the block. `seed.cleanup()` does the same thing
explicitly, and is safe to call more than once.

Seeded paths are relative and must stay inside their root. The seed root is canonicalized, so a
path a spawned tool resolves is the same string the seed reports.

## Shims

`shim(command, responses)` writes an executable onto the seeded `PATH`. Each response matches one
shape of invocation exactly, including how many arguments there are. Use `ANY_ARGUMENT` for a
position whose value a test cannot predict:

```ts
import { ANY_ARGUMENT, createSeedBuilder } from "@tryaura/aura-testkit";

const seed = await createSeedBuilder()
  .shim("fixture-agent", [
    { args: ["--version"], stdout: "fixture-agent 1.2.3\n" },
    { args: ["mcp", "add", ANY_ARGUMENT], stdout: "added\n" },
    { args: ["status"], exitCode: 7, stderr: "not ready\n" },
  ])
  .build();
```

The first matching response wins, so declare overlapping ones from most to least specific. An
invocation nothing matches exits `2` and reports itself on stderr.

Every invocation is recorded, matched or not:

```ts
await expect(seed.invocations("fixture-agent")).resolves.toEqual([["--version"]]);
```

Asking for a command that was not seeded rejects and lists the known shims. A seeded command that
has not run resolves to an empty list.

### Shim record contract

The invocation log is a public, versioned format. Each invocation is one ASCII line:

```text
aura-testkit-v1<TAB><argument-count><TAB><base64-UTF-8-argument>...<LF>
```

Empty and multiline arguments round-trip because every argument is encoded separately. A shim
builds the complete record in memory and appends it with one `printf`, so parallel invocations do
not interleave fields. Records are capped at 2,048 bytes; an invocation over that limit writes a
versioned truncation marker, and `seed.invocations(command)` rejects with the record size and limit
instead of returning incomplete arguments.

Generated shims require a POSIX shell and the standard `base64` and `tr` utilities available at
`/usr/bin`. Seed building fails immediately on Windows with an explicit platform error.

Versioned official-app fixtures are also exported for adapter and binary integration tests:

```ts
import { createClaudeCodeSeed, createCodexSeed, createCursorSeed } from "@tryaura/aura-testkit";

await using seed = await createClaudeCodeSeed({
  authenticated: true,
  version: "2.1.233",
});

await using codexSeed = await createCodexSeed({
  authenticated: true,
  version: "0.147.0",
});

await using cursorSeed = await createCursorSeed({
  rules: "legacy",
  version: "3.11.0",
});
```

## Running a check

`runCheck` runs `check --json` and returns:

- `report` — the whole JSON document. Assert against this rather than `findings` alone when a test
  needs to prove a check ran: a check that threw reports no findings and is explained only by
  `report.diagnostics`.
- `findings` — shorthand for `report.findings`.
- `exitCode` — `0`, `1`, or `2`.
- `diffs` — every change under the fake HOME and workspace, as unified patches whose first line is
  the entry's permission bits. Permission-only changes, empty directories, and binary files are all
  visible. The seeded `PATH` directory is not diffed; use `seed.invocations` for what a shim did.
- `stdout` / `stderr` — captured, with seeded absolute paths replaced by `<HOME>`, `<WORKSPACE>`,
  `<PATH>`, and `<SEED>`.

When a run produces no readable report, the failure carries the exit code and the CLI's own stderr,
which is where the actual explanation lives.

## Proving convergence

`expectConvergedTwice` runs a setup or fix callback twice and asserts that the second run reports
convergence, changes no captured path, and creates no undo-journal entry:

```ts
import { expectConvergedTwice, runSetup } from "@tryaura/aura-testkit";

const { first, second } = await expectConvergedTwice(seed, () => runSetup({ distro, seed }));
```

Paths under `agents/.backups/` are excluded from the diff comparisons and asserted separately by
journal entry name. Convergence is a claim about the machine's configuration, and the journal is
where a run records what it replaced — it also holds a target-lock directory a run touches whether
or not it writes anything, so comparing it byte for byte makes the assertion fail on timing.

The helper is test-runner independent and returns both results for additional assertions.

## Running a compiled distribution

`runBinaryCheck` applies the same seed and returns the same result shape while launching a compiled
Aura executable instead of calling `runCli` in process:

```ts
import { runBinaryCheck } from "@tryaura/aura-testkit";

const result = await runBinaryCheck({
  binaryPath: "/absolute/path/to/aura",
  seed,
});
```

The runner invokes `check --json` from the seeded workspace, supplies the seed's HOME and PATH, and
passes no ambient environment variables to the child. The binary path must be absolute, and `args`
may not repeat `--json`, `--home`, or `--path` — the runner supplies those and rejects a second one
rather than letting it parse as a duplicate.

Launch failures, signals, unsupported exit codes, and invalid reports reject with a captured
transcript. So does a run that hangs: `timeoutMs` (30 seconds by default) bounds how long the child
may take, after which it is killed and the failure carries whatever it had printed by then.

```ts
const result = await runBinaryCheck({ binaryPath, seed, timeoutMs: 5_000 });
```
