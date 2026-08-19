---
title: Check JSON and exit codes
description: The frozen version 1 contract for aura check and aura check --explain.
---

`aura check --json` emits exactly one JSON document on stdout. Prompts, previews, progress, and
usage errors use stderr so stdout remains parseable. Version 1 is the permanent default; pass
`--json-version 1` when a caller wants to pin that choice explicitly. `--json-version` requires
`--json`, and unsupported versions exit with code 2.

The package publishes the JSON Schema at
`@tryaura/aura-cli/schema/check-output-v1.json`. The schema accepts both envelopes below and is
also shipped in the package as `schema/check-output-v1.schema.json`.

## Check report

The `CheckReportV1` envelope has `kind: "check-report"` and `schemaVersion: 1`. It contains:

- `status` and `summary`, including the command exit code, diagnostic count, overall
  passed/info/warn/error counts, and the same counts keyed by check category. `status` describes
  the findings while the exit code describes whether the command completed;
- `apps`, with every selected real adapter in registry order, its canonical ID and display name,
  safe detection fields, and support information when installed;
- `diagnostics`, `passedChecks`, and `findings`; and
- optional `fixes` when `--fix` was requested.

An app record carries `detectionScope` only when its adapter looked for the application, did not
find it, and declares one. Treat the field as absent otherwise: an adapter that failed during
`detect` establishes nothing about the machine, and reports it as not installed with no scope
alongside a `diagnostics` entry naming the failure. The value names what the probe looked at — for
example `the codex CLI on PATH (the desktop app is not checked)` — so a consumer supplies its own
wording for the outcome.

Each finding includes `checkId`, `findingId`, severity, scope, fixability, and message. Details,
locations, metadata, and presentation are present only when supplied by the check.

Each fix record belongs to one executable finding plan and retains original finding order. Its
status is `planned` for a dry run, `applied` after a successful write, `failed` when preparation,
conflict detection, or application prevents the merged transaction from succeeding, or `partial`
when applying failed _and_ unwinding the operations already performed also failed. A `planned`
record can carry an optional `message` explaining why the run stopped before applying — the
interactive wizard was aborted, or no terminal was available for the confirmation prompt — so a
consumer that sees `status: "error"` with no error findings reads the reason here. `failed`
guarantees the filesystem is unchanged; `partial` is the only status that does not, and a run that
reports it leaves a diagnostic naming how many operations could not be undone. Operations
carry effects and affected paths. Unified diff text is omitted unless `--detail` is present because
instruction and configuration files may contain secrets. Skipped and manual-only choices remain
visible as post-run findings rather than being described as filesystem changes.

## Check explanation

`aura check --explain <id> --json` emits `CheckExplanationV1`, discriminated by
`kind: "check-explanation"` and `schemaVersion: 1`. It includes the check's ID, title, scope,
severity, fixability, canonical Markdown explanation, and `fixesApplicable`. The latter is true for
automatic and guided checks and false for manual checks.

## Exit codes

| Code | Meaning                                                                                        |
| ---- | ---------------------------------------------------------------------------------------------- |
| `0`  | The check completed and reported its findings, including warning or error findings.            |
| `2`  | Invalid options/selectors, no checks, unavailable confirmation, or a filesystem/fix conflict.  |
| `3`  | An adapter, check, plugin, registry, command, or fix preparation/application operation failed. |

`check` no longer emits code 1; the frozen version 1 schema continues to accept it for compatibility.
Diagnostics and forced command failures take precedence over finding severity, so a report containing
a warning plus a check diagnostic exits with code 3. Gate on `status` or the severity counts when
findings should fail CI.
