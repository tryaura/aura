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

it("reports a legacy config", async () => {
  await using seed = await createSeedBuilder()
    .homeFile(".fixture/config.txt", "legacy=true\n")
    .workspaceFile("AGENTS.md", "workspace instructions\n")
    .shim("fixture-agent", [{ args: ["--version"], stdout: "fixture-agent 1.2.3\n" }])
    .build();

  const result = await runCheck({ distro, seed });

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
