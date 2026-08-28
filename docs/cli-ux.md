# CLI UX contract

How Aura's command line looks and behaves, and why. The renderers in
`packages/cli/src/help.ts`, `packages/cli/src/help-distro-command.ts`, and
`packages/cli/src/setup/wizard-render.ts` implement this contract; the inline snapshots in their
test files pin the exact bytes. Change this document and the implementation together.

## Principles

1. **Action-first, not inventory-first.** Every screen leads with what the user should run next,
   not with an alphabetical dump of everything that exists. Commands and flags are grouped by the
   task they serve ("Everyday use", "Narrow it down", "Scripting"), ordered by how often that task
   comes up.
2. **Every screen answers "what do I do next".** Screens cross-link along the real workflow: root
   help points at `setup` first, setup's footer points at `check`, check's everyday rows surface
   `--fix`. An unknown command redirects to the command list instead of dumping a parser trace.
3. **Plumbing is demoted, never hidden.** Flags that exist for tests and CI (`--home`, `--no-color`,
   `--path`) sit last under "Advanced". They stay documented — honesty over minimalism — but they
   never compete with the everyday path. `--no-color` is consumed before any command parses, so it
   is the one Advanced row the root screen carries too; `--home` and `--path` belong to the
   scanning commands and appear only on theirs.
4. **Glyphs carry state; color only reinforces it.** Output must disambiguate on a monochrome
   terminal (`▶` active, `✔` done, `☐` pending). Color and bold/inverse/dim are enhancements,
   never the only carrier of meaning. `--no-color` and `NO_COLOR` disable color entirely;
   `FORCE_COLOR=0` disables it, while a positive `FORCE_COLOR` enables it explicitly. Automatic
   color is off in CI, for `TERM=dumb`, and whenever the process's stdout is not a TTY. Injected
   streams get zero escape sequences whatever the surrounding process sets, so captured output is
   byte-stable; an embedder that wants color asks for it with `colorDepth`.
5. **One machine-readable seam.** `--json` emits exactly one parseable document on stdout;
   everything else the run produces moves to stderr. Human output never leaks into the document.
   A reader closing the pipe early is normal use, not a failure: the run keeps the exit code it
   earned rather than reporting the truncation as success.
6. **Branding is injected.** Screens render from `CliBranding` (`command`, `displayName`,
   `version`, `description`, `docsUrl`) so every distribution gets correct help for free. Parts a
   distribution does not define are dropped, not placeholder-filled.

## Help surface

Rendered by `packages/cli/src/help.ts` and `packages/cli/src/help-distro-command.ts`; exact
layouts pinned in `help.test.ts` and `distro-command.test.ts`.

- `aura` / `aura --help` / `aura -h` — root screen: a three-line plain-English paragraph on what
  Aura is for, then Get started → Everyday use → Help → Advanced, then a `Docs:` footer when
  branding defines one. The paragraph is the one piece of prose in the help surface, and the root
  screen is the only screen that carries it: every other screen is reached by someone who already
  knows what the tool does. It is hand-wrapped at 80 columns because the renderer aligns columns
  and never reflows text. The Help section lists `aura <command> --help`, and an `aura --version`
  row exactly when branding carries a version (which is also when the flag is registered at all).
  Advanced carries `--no-color` alone.
- `aura check --help` — Everyday use, Narrow it down, Reporting, Configuration, Fixing behavior,
  Scripting, Advanced, then the exit-code footer. "Narrow it down" scopes what runs; "Reporting"
  (`--verbose`, `--detail`) controls how much the run says about it.
- `aura sessions --help` — Everyday use, Scripting, Advanced, then a footer stating the local-only
  privacy contract and the exit codes. Advanced carries `--home` and `--no-color` but not `--path`:
  the command reads transcripts, never executables, so the shared search-path override would be a
  parse error.
- `aura setup --help` — Everyday use, Options (including every registered `--add` kind),
  Advanced, then footers pointing at `check` and documenting setup exit codes.
- `aura undo --help` — Everyday use, Options, Advanced, then the restore exit-code footer.
- `aura <typo>` — `aura: unknown command '<typo>'`, the command list, and a pointer to `--help`.
  Exit code 2. A bad _flag_ on a real command keeps clipanion's own message, which names the
  offending flag.

Layout rules: terms align to one shared column across the whole screen; section titles are
indented two spaces, rows four; no boxes, rules, or banner lines; no trailing periods on row
descriptions. Clipanion's default help renderer is bypassed entirely (`runCli` intercepts the
internal help command and unknown-command errors).

### Distribution commands

A distribution may register additional top-level commands at build time (`CliDistro.commands`,
declared as data — word, summary, examples, flags — rather than framework classes). The help
surface treats them as first-class citizens, rendered from the same definition the parser is built
from so the screens can never drift from what parses:

- The root screen and the unknown-command screen list each registered command after the built-in
  rows, in declaration order: the workflow ordering of the built-ins holds, and additions extend
  the list rather than reshuffle it.
- `aura <word> --help` renders the same bones as the built-in screens: Everyday use (the
  definition's examples, or the bare word with its summary), Options (one row per declared flag,
  with its placeholder), Advanced, then the definition's footer lines. Advanced carries
  `--no-color` alone — a distribution command takes `--home` or `--path` only if it declares them
  itself.
- A misspelled word still gets the redirect screen; a bad flag on a registered command keeps
  clipanion's message, exactly as for the built-ins.

A registered command runs against the same injected `Environment` the built-ins and every plugin
use — `cwd`, `homeDir`, `now()`, `platform`, `pathEntries`, `readVariable()`, `exec()`, `httpGet()`
— built from the process boundary alone, so a command reads nothing from `process` itself and
behaves the same under the testkit and any embedder. `--home` and `--path` belong to the built-in
commands and stay off a help screen that would not honour them; a command that needs a different
root declares its own flag. It also gets a telemetry channel scoped to its own word: the
CLI stamps the word, event kind, timestamp, and distribution version, so a command can neither
send an unstamped event nor attribute one to a command it does not own, and the user's
`DO_NOT_TRACK` or `AURA_TELEMETRY=off` still wins. A command that throws is recorded as
`command-failed` with no error text, mirroring the built-ins; that label is reserved for the
crash record, so an event a command records under it itself is dropped.

The built-in words (`check`, `sessions`, `setup`, `undo`) and the framework's own (`help`, `version`) are
reserved, `--help` and `--no-color` cannot be declared as flags, and an invalid or colliding
definition fails the run at startup as an operational failure (exit code 3) rather than shadowing
a built-in at parse time.

## Check report

### Scan progress

A check run is dominated by probes Aura does not control: an adapter's `detect` execs the
application's own CLI, and a companion CLI that connects to every configured MCP server before it
answers takes seconds on its own. Nothing about the report can be printed until every one of them
returns, so the run says what it is waiting for instead of going quiet. Human output on a terminal
paints the same frame the setup wizard's opening scan uses — `Scanning this machine…` with one
status row per detected-application adapter (pending `☐`, an animated spinner while its probe runs,
then `✔`) — from the moment the scan starts, which is the first thing that happens after the
command's options and configuration resolve. Synthetic adapters model files rather than an
installed application, so they are never named as a row. A `--fix` run that applies something and
rescans paints the frame again for the second scan.

The frame is a display and nothing more: it never changes what the scan does or the order results
come back in, and it is erased before the report is written, so the report's first line is still
the report's first line. A run whose output is redirected, and a `--json` run, paint no frame at
all — their streams carry a document, not a display — so captured output is byte-identical with or
without a terminal attached.

### Report body

Human check output is action-first and grouped by subject. The concise default renders the human
verdict and severity counts, the one command that can address the available fixes, then one block
per subject — the application, file, or shared content the findings concern — ordered worst first.
Severity rides on each row and in the subject's own count line, while fixability rides on each
finding row, instead of either splitting the report into sections. A check that fires against two
applications therefore reads as one problem in two places rather than two unrelated ones.
Informational findings are suggestions, never manual work. Passed checks collapse into one summary
line.

A subject is derived, never declared, because a finding carries no first-class one. Aura takes the
first of: the plugin-supplied `metadata.appId`, honoured only when it names an application the scan
actually detected and then rendered as that adapter's own display name; the first of the finding's
locations; the producing check's title. The detection guard is what makes reading plugin metadata
safe — an unrecognized id falls through to a path, which is sanitized and shortened like any other
location. Every finding belongs to exactly one subject, so subject counts sum to the severity counts
in the headline; a finding naming several files is filed under the first and names the rest in its
body, because appearing twice would make those two totals disagree. Subjects order by highest
severity, then finding count, then label. Detected applications with no findings close the list on
one line each, so the report states the condition of the machine rather than only its problems.

Checks may declare a plugin-namespaced `findingGroup` with an action-oriented title and
description. Findings sharing that group render within their subject under one heading that states
the remediation once — but a group summarizes the _fix_, never the _evidence_: every member is
still named individually beneath it, with its detail and locations, either inline on the group's
own line or on a line of its own. Which of the two a group takes is a layout choice; naming every
member is not, so no run reports a count where it could report a file. The concise default caps
that list at three occurrences and two locations each and says how many more are waiting. A grouped
heading always carries its member count, including at one member, so a group whose findings differ
in fixability stays recognizable as one problem. Checks without a group remain individual, so an
older plugin never loses its message. Check IDs sit in a right-aligned column as secondary metadata
rather than leading a line, and the closing More section carries the `--explain <id>` that turns one
into a full explanation. Each finding row also names whether its remediation is automatic, guided,
or manual; a per-finding manual downgrade therefore remains visible inside a fixable group.

Human output has a hard ceiling of 100 findings total, selected errors first, then warnings, then
suggestions while preserving plugin order within a severity. Selection happens before grouping, so
the ceiling can leave a subject holding fewer findings than it counts. It names any omitted tail,
and a truncated subject heading carries both numbers (`Claude Code — 8 of 11 errors · 2 warnings`)
so it never contradicts the fix count in the recommended next step, which always speaks for the
whole run. A subject the ceiling emptied entirely does not print. Each shown finding likewise has a
hard ceiling of 100 locations, and one location line is bounded in length the same way a finding's
message is. Whenever either ceiling truncates, the More section points at `--json`, which remains
untruncated — no report offers `--verbose` for detail the ceiling has already dropped.

`--verbose` lifts the concise three-occurrence and two-location caps up to those safety ceilings and
adds metadata tables, passed checks, and the applications Aura looked for but did not find. It does
not restore a severity-first ledger, and it does not change the grouping: detected applications are
already subjects, so the flag has no inventory left to reveal for them. Indentation carries the
hierarchy: subject heading at zero spaces, each group heading or lone finding at two, its shared
description and occurrences at four, and an occurrence's own detail and locations at six. Project
paths render relative to the project root (the invocation directory outside a repository), home
paths use `~/`, and other paths remain absolute — one shared helper (`@tryaura/core/display-path`)
serves both the CLI's location lines and the paths checks bake into their messages, so a report
cannot name the same file two ways. `--verbose` works with scans and fixes but not with `--json` or
`--explain`;
`--detail` remains the separate gate for potentially sensitive plugin failure text.

The summary line above the subjects reports what was inspected, not a verdict: it takes a green `✓`
only when at least one check passed, and a plain `·` when the run inspected nothing.

The report recommends `aura check --fix` for every fixable finding, automatic and guided alike, on
one line that names the split ("16 fixes: 11 automatic · 5 guided, previewed first") so the user
knows whether the run will ask them anything and that nothing is written unseen. An operationally
incomplete scan recommends neither because its findings may be incomplete.

### Report width

The report lays out against the terminal's own width, clamped to between 40 and 100 columns. A
stream that reports no width — a pipe, a file, a captured test stream — takes 80, so redirected
output stays byte-identical with or without a terminal attached, exactly as the scan frame's absence
does. The floor is the width below which no alignment survives; the ceiling exists because a
right-aligned column drifting a hundred columns from the text it belongs to has stopped being
scannable.

Two columns are right-aligned to that width: a subject heading's severity counts, and a finding
row's check id. Text that would collide with the right column wraps at a word boundary rather than
truncating with `…` — a finding's message is bounded to 500 characters and can carry several rows —
and the right-hand value stays on the first row, with continuation rows indented to their own level.
A single word too wide for the column falls back to a grapheme-accurate hard break, because a long
path cannot be worded around. A row whose pinned value would leave its text too narrow to read keeps
the text and drops the value to its own line, right-aligned: a check id is secondary metadata, and
squeezing the message to hold a column straight costs more than the column is worth.

`--fix` asks the guided questions itself; there is no second flag to reach them. What separates a
run that asks from one that does not is capability, not intent: `--yes` forbids questions, `--json`
promises one machine-readable document a machine cannot answer, and a shell with no terminal on
both stdin and the prompt stream cannot ask at all. Only `--yes` authorizes automatic fixes without
a confirmation prompt; another run that cannot ask previews any automatic plan and reports that
confirmation is unavailable. When no automatic plan exists, the run prints what it left instead of
the fixless message — "Left 5 guided findings alone: this run cannot ask for the choices they need.
Run `aura check --fix` in a terminal, without `--yes` or `--json`." Reporting those as unavailable
would deny the findings the report lists directly below.

One question per plan, not per finding: a check may answer several findings with the same plan — a
whole-file credential rewrite covers every credential in that file — and the wizard asks about each
distinct plan once. The fix report then carries one entry per plan, and the re-scan after applying
is what says which findings remain.

## Sessions report

`aura sessions` reads the transcripts Codex keeps under `~/.codex/sessions` and the ones Claude
Code keeps under `~/.claude/projects`, and summarizes, per project, how much agent time they held
and where tool calls failed. Both sources fold into one report; `--source codex` or `--source
claude-code` (the `claude` and `claude_code` aliases resolve too) narrows the run to one of them,
and an unknown selector is invalid usage. A session belongs to the window when it started inside
it. Codex transcripts are pruned by their calendar directories; Claude Code transcripts, which
have no date layout, are pruned by file modification time — a file last written before the window
is never opened — and a session that started before the window but was touched inside it is
excluded after parsing. Claude Code subagent transcripts and sidechain records are not analyzed:
a session's metrics cover its main thread only. Internal `guardian` approval
reviews are excluded. A project collapses every working directory that resolves to the same
repository. The Git remote recorded when the session started is sanitized and used first. Its
credential-free host/owner/repository identity is the grouping key; the short repository name is
shown unless unrelated remotes share it, in which case their qualified names are used. When the
remote is missing, a directory that still exists is named after its current git `origin` remote
(following a linked
worktree's `.git` file to the main checkout), a deleted one falls back to the
`<...>/workspaces/<project>/<leaf>` shape parallel-worktree tools use, and anything else stays its
own path. Only `.git` markers and git config files are ever opened. A heading notes the collapse
(`family_planner · 12 directories`) whenever a row absorbed more than one. Rendered by
`packages/cli/src/sessions/render.ts` in the help-screen geometry, and ordered by what deserves
action, not by inventory: a header naming the scanned sources (`Codex + Claude Code` on a default
run) and window; four `Session health` cards;
short `Activity` and `Workflow and delivery` rows; command and work-item insights; `Projects by
agent time`, capped at five; then `Needs attention` as the final content section before the grade
legend. No single overall letter flattens those signals into a verdict.

The four fixed-width cards expose the measurements that explain health directly: tool-problem
grade, share, and count; peak context-window grade and occupancy; compaction grade, rate, and
count; and failed/total validation runs plus validation time. Validation is deliberately ungraded:
a red-to-green test iteration is useful work, and no trustworthy health threshold exists for it.
Missing inputs stay visible as `No tool calls`, `Not recorded`, or `No validation` / `runs
recorded`, so the card positions never move. Four 18-column cards plus their gaps fit from 77
columns upward; narrower reports use a 2×2 grid. All card sizing uses terminal display cells.

The detail sections use one concept per label/value row instead of chains of unrelated values.
`Activity` carries sessions/projects, agent time summed from recorded turn durations, turns, and
token directions. `Workflow and delivery` carries median turn time, tool-time share, cache reuse,
classified check/expected
statuses, a count of unclassified nonzero exits (`Unclassified`), human interventions, first-green
cost, initial context, inferred endings, and unreadable
or incomplete transcripts when those signals exist. Incomplete coverage names size truncation,
malformed records, rejected numeric values, and interrupted reads separately. Breakdowns use
continuation rows. Explanatory prose appears
only beneath unhealthy cards or flagged projects; healthy signals stay terse. Subscription
rate-limit state is deliberately not rendered:
the counter is account-global and shared by concurrent sessions, so no per-window attribution is
honest; the raw quota snapshot stays available in `--json`. There is deliberately no dollar
figure: transcripts carry no prices, and on
a subscription plan an API-equivalent estimate would read as real money. Every graded report
ends with the one-line legend `Grades: A great · B good · C fair · D poor · F failing`, so the
scale never needs a manual. `Commands by tool time` is capped at five entries with a counted
`--json` pointer for the rest and is absent when empty. It gives each (command, subcommand)
identity a primary bar/time row and an indented calls/failure row, so `git diff` shows up apart
from `git push`. `Work items · keys seen in prompts, branches, and git/gh commands` summarizes
the loose issue-key joins as p50 and p90 sessions per issue key, together with the sample size;
the full per-key aggregates remain available in `--json`. The bands
are deliberately coarse so ordinary variation between windows does not flip a grade — in tools:
A under 10%, B under 20%, C under 35%, D under 50%; tool problems: A under 2%, B under 5%, C under 10%,
D under 20%; compactions per session: A under 0.1, B under 0.3, C under 0.6, D under 1; cache
hit, graded on the miss share with the same bands as in tools, so A means at least 90% reused;
context occupancy: A under 50%, B under 70%, C under 85%, D under 95% — an F means compaction
was imminent when the session peaked. The projects section is a bar chart: each project gets a
primary bar/agent-time row and an inventory continuation for sessions and directory spread.
`--verbose` adds tool-problem, check-failure, and cache detail without packing it onto the primary
row. Bars are drawn
with `█` fill, `▏`–`▉` partial cells, and a `░` track, so they disambiguate without color; a
nonzero value always shows at least a sliver of ink, and labels longer than the column truncate
with `…`. Non-success outcomes are classified conservatively: missing executables and MCP errors
are operational failures; recognized test-runner summaries are check failures; pending GitHub
checks and simple search no-matches are expected statuses; everything else is unknown. Compound
shell input is named `shell batch`, never attributed to its first command. For failed batches,
Aura extracts up to twelve top-level executable/subcommand identities from the input, aggregates
the five most frequent identities in JSON, and shows up to three after `contains:` in an attention
finding. These are components observed in the failed batch, not a claim about which segment
failed. Quoted text, comments, nested commands, and heredoc bodies never become component
identities. Operational and unknown outcomes together set the tool-problem grade; check failures receive their own count,
while expected statuses do not make a project unhealthy. `Needs attention` is a list of findings,
one line each, not a per-project dossier: most non-success outcomes are ordinary agent work, so a
raw count never makes a finding on its own. The findings, in order: a missing executable
(exit 127) grouped by name across the whole window with its remediation attached, because it is
fixed once, not per project; a project whose failure rate stands out — at least three confirmed
environment failures that are also at least one percent of its calls, or ten-plus problem
outcomes at a rate above five percent and double the
rest of the window — named with its rate, the fleet rate, and its worst outcome signature; a
project where two or more sessions ran validation and never saw it pass; and compaction pressure,
where a single compaction stays routine. Low-confidence unknown exits count only toward the rate
comparison, never as findings themselves, and their total stays visible in the `Unclassified`
workflow row. Incomplete transcripts are coverage, not trouble: they stay in the workflow rows
and never flag attention. The findings list is capped at eight entries. Neither this cap nor the
project-chart cap is silent: each counts what it withheld and points at `--verbose`, which lists
every finding and replaces the chart with every project in
the window. A window with nothing to
flag simply has no `Needs attention` section. Recorded paths shorten under the effective home
directory to `~`; every path and command name is neutralized before it reaches the terminal, and
only safe command labels appear, never full command lines.

The privacy contract is the footer's one promise: the analysis is entirely local, and neither
`--json` nor the human report carries transcript content. The human report exposes only aggregate
metrics and neutralized command labels; `--json` additionally carries local evidence metadata such
as transcript paths, working directories, branches, sanitized repository remotes, and session
identifiers. URL userinfo is removed before repository metadata reaches any result. It emits the one
machine-readable document — window, per-project aggregates, and per-session metrics — on stdout
under the same seam rules as `check --json`. Per-session metrics carry turn-level detail (start,
end, close state, harness-reported duration and time to first token, model, per-turn tool time and
token deltas, capped at 500 turns with a truncation flag), interventions (interrupts and
re-prompts), context-window occupancy (window size, first-request and peak request tokens), and
call totals folded by (tool, command, subcommand) so `git diff` and `git push` stay distinct — the
subcommand is read only for a known set of multi-command executables, never from arbitrary
argument text. Failed shell-batch outcomes also carry the bounded component identities and their
aggregate occurrence counts; they do not carry command arguments or identify the failing
segment. `--detailed` additionally carries one row per recorded tool call (id, line, turn,
start, duration, status, exit code, output size); it requires `--json`, because per-call rows are
machine output. The JSON document only ever gains fields; existing fields keep their names and
meanings. The top-level `source` field predates multi-source analysis and stays frozen at
`"codex"` whenever Codex was in scope, so a default run's value never changed; the `sources` array
is the authoritative list of what the run scanned for, and each session carries its own `source`.
Claude Code sessions record failure structurally rather than via exit codes, so their outcome and
per-call rows carry no exit code, and their tool output totals undercount results Claude Code
offloaded to sidecar files. An empty window is a normal report (exit 0), not a
failure. Transcripts are parsed as bounded streams with at most four reads in flight; a transcript
larger than the read cap is counted as truncated rather than sinking the run. Malformed records,
out-of-range numeric fields, and interrupted prefix reads mark a recognized session as partial and
are counted in human and JSON output. Transcript numeric values use field-specific bounds and
overflow-safe aggregation.

`--brief` (or `--brief=<path>`) additionally writes an owner-readable agent handoff brief (default
`aura-session-brief.md` in the working directory) and prints the one shell-quoted command that
hands it to a coding agent — `codex exec` whenever Codex was in scope, `claude` for a Claude-only
run. It refuses to replace an existing target unless the user
also passes `--force`.
The brief is a self-contained markdown prompt built on the same premise that agent context is
scarce: every aggregate is precomputed, and raw evidence stays on disk. Each outcome group carries
up to two paired call/result pointers selected across sessions, plus the recorded working directory,
git commit/branch, initial-prompt size, and the exact prompt lines needed for historical instruction
claims. It states evidence coverage, separates operational, check, expected, and unknown outcomes,
uses the same materiality and ordering as the human report, and includes a session-level compaction
comparison without claiming causality. It details at most three troubled projects and ends with
evidence-bounded investigation and output rules. Every transcript-derived string is encoded as a
single JSON literal and the prompt treats those literals as untrusted data, so a recorded path,
branch, or tool name cannot add Markdown instructions. `--brief`
contradicts `--json` (the brief is the handoff document) and composes with `--days`.

## Exit codes

For `check`: `0` completed check, regardless of finding severity · `2` usage/state conflicts or no
checks · `3` operational failures. Finding health remains visible through the report status and
severity counts. Setup and undo also use `1` for incomplete user-driven flows. `sessions` uses the
check triple: `0` report produced, even when the window is empty · `2` invalid usage · `3`
operational failures. `runCli` normalizes any other code to 2.

## Automatic updates

Standalone distributions may install a newer release before the requested command runs. Both the
lines and the outcome mapping live in `packages/cli/src/update/run.ts`, pinned by
`startup-update.test.ts` and `install.integration.test.ts`.

An argument-free standalone run participates in the same automatic check before rendering root
help. `aura update` is the explicit path: it ignores cached update outcomes, installs an available
release, reports its outcome, and exits immediately instead of dispatching another command. It
returns `0` when current or installed, `1` when another updater owns the installation, `2` when the
environment is ineligible, and `3` on a check or installation failure.

During an automatic check, the updater is a guest in someone else's command. It obeys three rules:

1. **It never changes the verdict.** No outcome — including a refused download — alters the exit
   code or the stdout of the command the user asked for. `--json` stays one parseable document.
2. **It speaks on stderr, and rarely.** Two lines for a successful update, one for a failure, none
   for anything else. A check that found nothing, a network that was not there, and a lock another
   updater holds are not events in the user's day.
3. **It never claims this run was updated.** The process keeps the image it started with, and the
   success line says so rather than sending someone to `--version` to find the old number.

Exact bytes, with `<Name>` from `CliBranding.displayName`:

```text
Updating <Name> 0.5.0 -> 0.5.1...
Updated <Name> to 0.5.1. The new version will be used on your next run.
```

Between those two lines the archive download paints one repainting frame, erased before the outcome
line is written:

```text
  Downloading… 42%
```

It exists because the download is the only part of an update the user waits on, and a release
archive is tens of megabytes: on a thin connection an unchanging line is indistinguishable from a
hung command. Painted through `terminal-frame.ts` like the scan surface, only when stderr is a
terminal — so a captured run is byte-identical to one where it never existed, and the two lines
above remain the whole message contract. The percentage stops at 99 until the transfer completes.

| Outcome                          | Message                                                                                                                      | Requested command |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Current, or a fresh cached check | None                                                                                                                         | Runs normally     |
| Metadata request failed          | None                                                                                                                         | Runs normally     |
| Another updater holds the lock   | None                                                                                                                         | Runs normally     |
| Update installed                 | The two lines above                                                                                                          | Runs, old version |
| Download or permission failure   | `<Name> could not install the 0.5.1 update. Update manually: <url>`                                                          | Runs normally     |
| Digest mismatch                  | `<Name> refused the 0.5.1 update: the download did not match the release's published SHA-256 digest. Nothing was installed.` | Runs normally     |

A command-derived debug variable — `AURA_UPDATE_DEBUG` for the official binary — traces every gate
and outcome to stderr as `update: <what happened>`. It is a developer affordance
for whoever is wiring a distribution up, deliberately outside this contract: off by default, never
suggested to a user, and free to change shape. Rendered by `update/diagnostics.ts`.

The manual-update link comes from `CliUpdates.manualUpdateUrl`, falling back to
`CliBranding.docsUrl`; when a distribution defines neither, the sentence is dropped rather than
placeholder-filled. The digest line never offers a link — retrying by hand is not the advice.

Startup updates run only for an interactive standalone run: all three streams must be terminals,
`CI` must be unset, and the command-derived disable variable (`AURA_UPDATE` for the official binary)
must not be `off`, `0`, `false`, or `no`. Variable names uppercase `branding.command` and replace
non-alphanumeric runs with `_`. Machine-oriented and scripted runs stay pinned to the binary they
selected, which is why a captured `--json` run is byte-identical whether or not a release exists.

## Glyph vocabulary

| Glyph   | Meaning                                          |
| ------- | ------------------------------------------------ |
| `▶`     | Active tab/step                                  |
| `✔`     | Completed step                                   |
| `☐`     | Pending step, or an unchecked multiselect option |
| `☑`     | A checked multiselect option                     |
| `◪`     | A pack row with some, not all, members checked   |
| `●`     | The currently selected option of a select        |
| `○`     | An unselected select option                      |
| `❯`     | Cursor row inside a question body                |
| `│`     | Tab separator                                    |
| `└`     | Sub-row connector under the active step          |
| `·`     | Separator inside hint lines and footers          |
| `█`     | Filled cell of a report bar                      |
| `▏`–`▉` | Partial final cell of a report bar               |
| `░`     | Empty track of a report bar                      |

Plain ASCII/Unicode only, no emoji. The one animation is the loading spinner, shared by the setup
wizard's loading frames and the check scan's progress rows; it never appears in report output, and
every surface that animates erases itself before anything durable is printed.

## Setup wizard tab bar

The wizard header is a single horizontal tab bar listing **every** step, always, in flow order —
plus **Submit** as the final entry. The bar is a map of the whole flow, not a viewport onto it: no
rolling window, no `← … →` overflow arrows, no hidden steps. The user must be able to see at a
glance how many steps exist, which are done, and where they are.

### Anatomy

One or two lines. The **top row** is a static map of the flow's real steps, separated by `│`,
always in flow order, ending in **Submit**:

```
 ✔ Applications │ ▶ Instructions ☐ │ Snippets ☐ │ Skills ☐ │ MCP ☐ │ Baseline ☐ │ Submit
```

The top row never mutates as a step's internal forms advance: the active step keeps its own name
(`▶ Instructions ☐`) for as long as any of its forms is live.

When the active step runs a sequence of internal forms (a chain step like Instructions), a
**sub-row** prefixed with `└` maps that step's internal progress around the live form:

```
 └ ✔ Personal │ ▶ Sources ☐ │ Duplicates ☐
```

- The live form's questions appear individually (`▶ Duplicate 2 ☐`); a completed or upcoming
  stage collapses to its stage label (`Duplicates`).
- The sub-row has no Submit of its own; its inactive tabs render dimmed where the terminal
  supports it — on monochrome the `└` prefix alone carries the hierarchy.
- The sub-row is an honest map: a conditional stage appears the moment its precondition holds and
  disappears when it stops holding. A stage behind the live form shows `☐` even when a
  remembered answer will re-seed it.
- Instructions setup has one `Personal` action. Repository instruction files remain visible to
  checks, but never appear as setup sources and Aura never links, archives, or rewrites them.
- A target that already holds instructions and whose scan found nothing to merge into it is
  settled: it contributes no tabs to the sub-row, and the step states what it found instead of
  asking a question whose every answer either changes nothing or overwrites text Aura did not write.
- The same reasoning binds the answers the target can settle on, not just the ones it is shown: an
  action that was not on the menu falls back to the proposed one, and a Personal target whose
  Sources form ends up empty is a blocker rather than a silent decline through the back door.
- **A recommended row leads its menu.** Wherever a question recommends an answer, that row is `1.`,
  carries a dim `(Recommended)` after its label, and is the row the form opens marked and with the
  cursor on it — the advice, the mark and the cursor never sit on different rows. At most one row
  per question is recommended; the rest keep the order they were built in underneath. The label is
  a promise about the form's own proposal: it may only sit on the row a question already selects,
  which is also the row `--yes` takes and the one a missing answer falls back to. No surface
  recommends an answer an unattended run would not reach.
- On the instruction action menu that row is `Combine found instructions`, wherever the scan found
  anything to combine — the answer the step exists to give. It leads even where a target exists to
  keep, so `Keep existing shared file` follows it; the remaining order is unchanged, least invasive
  first. A target with nothing to combine recommends nothing, and its menu is
  that build order as it stands.
- **Consolidating is a migration, not a copy**, and every surface that offers it says so: the
  option's description, and a footer line on `setup --help`. The sources it merges are backed up
  and taken off disk in the same plan, and `undo` restores them. Because it is also what the menu
  proposes, this is what `--yes` takes on any machine whose scan found sources — the run whose plan
  summary still lists every move before applying it, and whose every move `undo` reverses.
- A source the merge could not place is the exception: its provenance heading is already in the
  target, so nothing new was appended, and the file has changed since. Archiving it would delete
  the only copy of what it now says, so it stays where it is and the run names it under _Steps to
  take yourself_ until someone resolves the divergence.
- The Skills step is the second chain precedent: its Review stage exists only while a directory
  skill is selected or a recorded skill's source revision moved, one review question per skill —
  `└ ✔ Skills │ ▶ Review claude-md ☐ │ Review commit-style ☐`.
- The Snippets step is one picker. Installed IDs lead it under an `Already installed` heading,
  locked, so the step only ever adds; it has no Review stage because Aura never revises installed
  snippet text.
- Before the picker, private directories appear in an explicit connection form naming the URL and
  token variable. Its initial selection is empty, including under `--yes`; no credential is read
  until the user opts in for that run.
- A step whose single form is named like the step shows no sub-row.

Tab states, in either row:

- Active tab: `▶ ` prefix (plus inverse where the terminal supports it). Never a box around the
  active tab.
- Pending: trailing `☐`.
- Completed: leading `✔`, no checkbox (`✔ Applications`).
- Submit: label only — no `☐`/`✔`. It is an action, not a step. When active it gets the same
  `▶ ` prefix; while locked it renders dimmed.

### States & navigation

- ←/→ (and tab; shift-tab moves backward like ←) move focus across the live form's tabs, and past
  its ends they move through the flow: shift-tab stops at the first tab, while ← past it _backs
  out of the form_ — the previous form reopens with the answers
  it was given, all the way back to the first step — and → past the last tab _commits the form as
  it stands and advances_, so a backed-into flow retraces forward without re-answering. → never
  reaches Submit: it stops on the flow's last form, and on the Submit confirmation it is inert.
  Submit is an action, not a step, so getting there is always an explicit ↵. A step re-entered
  backward opens on its **last applicable** form — the last one that step actually asked, which for
  Instructions is Project Duplicates when a duplicate review applies, otherwise Project Sources,
  otherwise the Global action — a step with nothing to ask passes ← straight through, and the final
  confirmation backs out into the last step the same way. Informational banners print only on a
  step's first visit.
- Re-entering a completed form shows its current answers and allows changing them: a select marks
  its standing answer with `●` and opens with the cursor on it, a multiselect keeps its `☑`
  checks, a free-text draft is re-seeded. → never re-answers — it commits the form exactly as it
  stands. An answer kept the same preserves everything answered after it; a changed answer
  regrows the chain from that point (a conditional step whose precondition no longer holds
  disappears, one newly triggered appears).
- Submit resolves the form only when every required step is `✔`; until then it renders dimmed,
  ←/→ can still focus it, and ↵ is a no-op — the Submit body explains what is missing
  ("Submit unlocks once every step below is answered." plus the `☐` list).
- Conditional steps (e.g. instruction-duplicates review) appear in the bar the moment they are
  triggered, inserted at their flow position. The bar must always be an honest, complete map of
  the current flow.

### Width behavior

Full labels are the default. If the bar would exceed the terminal width, degrade in this order —
never reintroduce scrolling and never truncate with `…`:

1. Compact labels (`WizardQuestion.compactLabel`: `Apps`, `Base`, `MCP`, `Dup 1`, …).
2. Glyph-only for non-active tabs (`✔ │ ✔ │ ▶ Snippets ☐ │ ☐ │ ☐ │ Submit`) — the active tab always
   keeps its label, and Submit keeps its label.

Each row degrades independently; the sub-row's active question keeps its label just as the top
row's active step does. The full step name is always repeated in the question heading below the
bar, so compact tabs lose no information.

### General

- The bar is purely informational + navigational; all answering happens in the body below it
  (↑/↓ move, digits jump, ↵ answers and advances).
- Space marks the row under the cursor and stays put: a multiselect toggles its `☑`, a select
  moves its `●`. Marking never answers the step by itself — the tab stays `☐` until ↵ answers it
  (or → commits the form as it stands). A disabled option can never be marked; a multiselect's
  already-marked one can still be cleared. A **locked** option refuses both directions — it
  reports a fact the form is not asking about — and states what it is in its label and group
  heading rather than a `—` note. Digits jump to a row and mark it the same way.
- Numbers run over the rows a digit can address, so a **locked** row carries none: the rows under
  it are numbered `1.`, `2.`, … as if it were not there, and it renders `✔` in the checkbox column
  (a box would invite the space press the lock then swallows), its marker held under the numbered
  ones by a blank gutter. Its label can carry dim ` · <note>` context — where the row came from,
  for a record block gathered out of several groups. A free-text row takes the number after the
  last one the options spent.
- A locked row is a record, not an answer: the Submit tab's review line and the collapsed
  `✔ <step>  <answer>` line list only what this run chose, so a step that ticked nothing new reads
  `(none)` however much the record above it holds.
- A form opens with the cursor on the row its answer stands on, and failing that on the first row
  that can be marked — leading disabled and locked rows are read, not answered with, so the first
  space struck is never a no-op. ↑/↓ then step **over** every locked row and wrap past the block
  entirely: `❯` points at a row the reader can act on or it is lying, and a lock refuses every key
  that acts on a row. Disabled rows still take the cursor — a mark seeded before the source went
  away can still be given up there, so there is something to point at. A screen with no markable
  row at all opens on its first and ↑/↓ leave it there: there is nothing to skip ahead to, and the
  footer drops the marking segment rather than promising a key that would do nothing.
- Footer hint line: `↑/↓ move · space toggle · ←/→ steps · ↵ select · esc cancel` on a
  multiselect, `↑/↓ move · space select · ←/→ steps · ↵ confirm · esc cancel` on a select
  (segments appear only when applicable; a locked Submit drops `↵ submit`, and a question with no
  row left to mark drops the marking segment along with it — every row locked, or locked and
  unavailable between them. A disabled row that opens marked still has a mark to give up, so it
  keeps the segment.)
- Once a form resolves, it collapses to one `✔ <step>  <answer>` line per step — printed on the
  form's first completion and again only when a re-answer changed it, so back-and-forth
  navigation never stacks duplicate lines and the scrollback's last word is never a stale answer.

### Preview overlay

When any option of the active question carries a preview (`WizardOption.preview` — e.g. a
snippet's full content), the footer hint gains a `p preview` segment. Pressing `p` with the
cursor on such an option (inert on a disabled option, or one without a preview) replaces the
whole frame with a scrollable overlay:

```
<option label, bold>

<preview body>

 ↑/↓ scroll · 12 more lines · esc/↵ return to picker
```

- The body is sanitized like all plugin text and hard-wrapped to the viewport width (never
  narrower than 40 columns), then clipped to one screenful — title, two blank lines, the hint,
  and a row of headroom are the only chrome.
- The footer's `· N more lines` segment (singular `1 more line`) appears between `scroll` and
  `esc/↵` only while lines remain below the window.
- ↑/↓ scroll one row; page up/page down scroll ten. `esc`, `↵`, or `p` return to the picker with
  the selection untouched; ctrl+c still aborts the wizard. While the overlay is open every other
  key is inert.
- The skills Review form leans on this overlay as its security boundary: the Install option of a
  directory skill carries the full fetched SKILL.md as its preview, so the whole prompt content is
  one `p` away at the decision point.

### Repository preset trust

A repository's `.aura/preset.json` is a configuration layer above the selected team preset and
below the user's manifest — and it arrives by cloning, not by anything the user selected, so it
applies only after the user trusts it for that repository.

- Interactive `setup` asks once, before the wizard opens, after one note naming the preset and one
  aligned row per thing the repository would introduce:

  ```
  Repository preset "Valencia repository entities" — .aura/preset.json

    mcp      repo/docs "repo-docs" → stdio "npx", args ["-y", "docs-mcp"], env DOCS_TOKEN
    skill    release-runbook (2 files)
    snippet  repo/commit-guidance (55 B)
    sources  repo:workspace

  Trust it? Nothing installs until you pick it; applies to every run here until the file changes.
  ```

  Rows carry the kind terms `mcp`, `skill`, `snippet`, `directory`, `sources`, and `checks`, in
  that order, padded to one shared column. One row per entity, never one per field: a snippet the
  preset both provides and selects is one snippet, and naming it twice is what made this screen
  long enough to skim past. Policy that points at content the repository does not provide keeps a
  row saying where it comes from — `mcp official/github · required, from the catalog`,
  `skill directory:acme/review · selected`, `snippet official/engineering · selected` — and a
  provided server the preset also requires carries a trailing ` · required`. `directory` prints
  every skill-directory URL plus its token variable
  (`Acme Skills → https://skills.acme.example · token ACME_TOKEN`), so repository-controlled
  network endpoints are visible before consent. `checks` spells out each enabled or disabled
  check, severity, and threshold (`SEC-001: disabled; TOK-001: thresholds {"approxTokens":12000}`);
  the effective values also print in the plan summary's read-only policy group once the layer
  applies. A provided MCP server carries its full executable surface verbatim (escaped):
  `stdio "<command>"` plus `args [...]` and `env ...` when set, or `http <url>`. A snippet's body
  is never echoed into the consent prompt — the byte count says there is one, and the picker's `p`
  overlay is where it is read. A preset with nothing to review prints
  `No check, MCP, skill, or snippet settings.` in place of the rows. The opening note is
  `Repository preset "<name>" — .aura/preset.json`, dropping the quoted name when the preset
  carries none. The prompt is
  `Trust it? Nothing installs until you pick it; applies to every run here until the file changes.`
  — the two-tier contract rides in the one line the user is certain to read, and shortens to
  `Trust it? Applies to every run here until the file changes.` when the repository provides no
  content of its own. Inside a linked worktree the prompt is preceded by one more
  note: `This directory is a linked worktree, so trusting these contents also applies them in every
other worktree of the same checkout.` Accepting applies the layer for the run and records the
  acceptance — the preset's absolute path, the repository's primary Git checkout when the run is
  inside a linked worktree, and a hash of its contents — in the manifest immediately, before the
  wizard opens. Only the prompt decides: declining or aborting it records nothing, and the next
  interactive setup asks again. Aborting ends the run with `Left everything as it was.` and exit 1.

- Consent outlives the run that gave it. Because the acceptance is written before the wizard, a run
  the user then backs out of, declines, or blocks still keeps it — asking a security question again
  because someone changed their mind about an unrelated step is how a person learns to accept
  without reading. A run that recorded trust and applied nothing else closes with `Recorded your
trust of .aura/preset.json. Left everything else as it was.` instead. `--dry-run` records nothing
  and says so: `Dry run: the acceptance of .aura/preset.json was not recorded, so the next run asks
again.` The record is written through the fix-plan kernel like every other file, so it makes its
  own backup: a run that records trust and then applies a plan produces two, and `undo` reverses
  them newest first — the plan, then the trust.
- Trust binds to exact contents, and to the repository rather than the directory. The hash covers
  every byte the repository contributes: the preset file itself plus every snippet body under
  `.aura/snippets/` (a repository with no snippets hashes exactly as the bare file, so existing
  trust records keep matching). Editing, adding, or removing any snippet re-asks the same way
  editing the preset does. Skill trees under `.aura/skills/` sit deliberately outside the hash —
  they are offers the per-skill Review gates, not bytes an unattended run could apply. A file that
  changes after acceptance is untrusted again, and the next interactive setup re-asks as a change,
  never as a first sighting (`The preset changed since you trusted it. Trust the new contents?`,
  above the same rows and the note naming the file) — that wording is keyed to the file in front of
  the user, so a sibling worktree carrying different contents is a first sighting, not a change. A
  linked worktree holding contents already accepted for its checkout applies them without asking,
  since anyone who can write the file in one worktree can write it in all of them. Each distinct
  set of contents a repository's user accepted keeps its own entry, so reverting the file to an
  earlier accepted revision does not re-ask.
- Non-interactive runs never accept: `--yes` answers confirmations for the user, and the first
  application of a repository's file is exactly the decision it must not answer. `setup --yes`
  resolves without the layer and the plan summary carries the held notice (below). Human `check`
  and `check --explain` output name the held policy. Their JSON documents expose the same state as
  `configuration.repositoryPreset = { "path": ".aura/preset.json", "status": "held" }`. `check` prints
  one `· Configuration` group line naming the fix (`Repository preset .aura/preset.json is present
but not trusted on this machine, so it was not applied. Run <command> setup to review and trust
it.`).
- An unreadable or invalid repository preset fails the run closed with exit 2
  (`Repository preset ".aura/preset.json" is not valid JSON. Fix or remove the file to
continue.`): proceeding without it would silently widen whatever the file was written to lock
  down. A broken snippet set — an unreadable, oversized, symlinked, or non-kebab-named file under
  `.aura/snippets/` — fails the same way: those bytes are inside the trust hash, so "some of what
  you consented to cannot be read" is a broken preset, not a smaller one. A broken skill tree
  under `.aura/skills/` only earns a note and drops out of the offers.
- Held means invisible. An untrusted repository contributes no snippet, skill, or MCP rows to any
  picker and no default ticks — trust is what admits the rows, and per-entity selection (a tick, a
  Review install, a configure form) is what installs anything.
- Repository snippet rows always open unticked, including when the repository preset lists them.
  The list adds the `(from repo)` label but is not approval to append arbitrary agent instructions;
  only an explicit interactive tick first-installs one, and `--yes` never does.
- Applied repo-layer check settings appear in the plan summary as their own read-only policy
  group, mirroring the team preset's: values apply through configuration resolution and are never
  copied into the manifest.

### Opening scan

Setup opens instantly: the only work ahead of the first interactive frame is reading the
manifest, so the repository-trust prompt (when one is due) appears with no perceptible delay,
and no network request or adapter probe ever runs before it. The machine scan — every adapter's
detect, including probes that exec a companion CLI and can take many seconds — starts the moment
the trust prompt resolves, overlaps configuration resolution, and is awaited only where the Apps
step needs its result, behind the same loading frame the Skills step uses: the prompt reads
`Scanning this machine…` with one status row per adapter (pending `☐`, an animated spinner while
its probe runs, then `✔`). Progress made before the frame opened is replayed into it, and a scan
that settled before the wizard needed it skips the frame entirely. Aborting the trust prompt
still means no adapter ever ran, and configuration that resolves invalid cancels every speculative
adapter command before setup reports the problem.

### Snippets step

One multiselect over the snippets registered by installed plugins. What is already installed
leads it as an unnumbered record block; the numbers below count only what a tick would change:

```
 Which snippets should Aura add to the shared instructions?

 Already installed
     ✔ Commit conventions · git
     ✔ Pull request descriptions · git
     ✔ TypeScript style · language
      Aura keeps the record; the text stays where it is.

 atlassian
❯ 1. ☐ Confluence references
      Reference Confluence without hiding execution-critical context.
  2. ☐ Jira issue linking
      Keep Jira issue references consistent across development artifacts.

 language
  3. ☐ Python style
      Apply typed Python conventions with consistent Ruff validation.
```

- An uninstalled available row can be selected and previewed. A preset ticks it by default only
  while its ID is absent from the manifest and a plugin actually provides it: a disabled row that
  opened ticked would be an answer `--yes` has no way to take back.
- A trusted repository's `.aura/snippets/*.md` files appear as offerable rows under a
  `From this repository` group that leads the offered rows, ahead of the plugin categories —
  they are this repository's own guidance, which is what a person running setup inside it came
  for. Each row's id is `repo/<file-stem>`, its optional frontmatter supplies the name and
  description, and its `p` preview is the exact body a tick would append, taken from the snapshot
  the trust hash covered — never a re-read. An id the repository preset's `snippets` list selects
  is labelled `(from repo)` but still opens unticked: arbitrary agent instructions require an
  explicit interactive selection, and `--yes` never first-installs them. An installed repo snippet
  joins the locked record block with ` · From this repository` as its note. An untrusted repository
  contributes no rows at all.
- A row no installed plugin provides renders disabled with `— source unavailable` and can never be
  ticked. Selecting one anyway — from a preset, a scripted answer — leaves it out of the install
  and reports it under "Selections Aura could not apply"; every other selection is still applied.
- A manifest-recorded ID renders as a locked, unnumbered `✔ <name>` row under the leading
  `Already installed` heading, whether or not its plugin source is still available. It opens
  ticked, space is inert on it, no digit addresses it, and the cursor neither opens on it nor can
  be moved onto it — the whole block is read, never pointed at. It carries no `p` preview for the
  same reason, and would have nothing honest to show anyway: the plugin's text today is not the
  bytes that were appended, and the record line below says where the installed text now lives. Its
  dim ` · <note>` reports the category it came from, or `plugin unavailable` where no installed
  plugin publishes its text any more. The block carries one shared line, on its last row:
  `Aura keeps the record; the text stays where it is.`
- Pulling those rows out of their categories is what lets the offerable rows number from `1`, and
  it empties any category whose every snippet is installed — no heading is printed for it. When
  every registered snippet is installed the prompt itself says so:
  `Every snippet the installed plugins provide is already in your instructions.` When what is left
  below the record block is only rows no installed plugin publishes, the prompt reports that
  instead — `Nothing here can be added: every snippet is either installed already or unavailable.`
  — and the footer drops `space toggle`, because neither kind of row answers to it.
- Applying the plan appends each newly ticked Markdown fragment directly to `~/agents/AGENTS.md`,
  in picker order, with one blank line between fragments and the file's line endings. Aura writes
  no ownership markers and records each ID with a hash of the text it appended.
- The manifest is install history, not desired instruction text. Aura never rewrites an installed
  snippet, and plugin changes, missing sources, and manual edits never trigger reconciliation or
  drift findings.
- The step is add-only: an install record is never dropped, and no answer removes a byte of the
  shared file. Aura planted the text unmarked and cannot tell it from the user's own guidance, so
  guessing which bytes to remove would take their edits with it — and forgetting the record instead
  would only offer to append the same text a second time. Dropping the entry from `~/agents/aura.json`
  by hand is the one way back to an offered row.
- The recorded hash is the only handle left on unmarked text, and the step spends it on two notes
  before the picker: that an installed snippet's source has moved on from the text in the file, and
  that a snippet recorded as installed is no longer in the file at all — the second naming
  `~/agents/aura.json` as where to drop the record. Neither is reported for a record written without
  a hash or for a snippet whose plugin is absent — there is nothing to compare, and reporting it as
  drift would cry wolf on every run.
- Legacy marked blocks remain byte-for-byte untouched and have no role in the picker.

### Skills step

A picker over every allowed skill source, then one Review form per selected remote skill.

- A trusted repository's `.aura/skills/<id>/` trees are offered as their own source,
  `repo:workspace`, named `This repository`. Its rows lead the installable rows — after the
  leading unavailable/truncated source rows and the `Skill packs` group, ahead of every other
  source's entries. Each row previews the SKILL.md captured in the trusted snapshot; installs
  copy that snapshot's bytes, never a re-read. The source flows through `allowedSkillSources`
  like any other (`repo:workspace` must be permitted where an allowlist is in force). A skill
  selection the repository preset makes is labelled `(from repo)` and arrives pre-selected the
  way team-preset selections do. **The first install of a repository skill always passes the
  Review form, and Skip stays the initial answer** — the trees arrive by cloning, not by anything
  the user selected, so "local files" earns no exemption here; a `--yes` run can only re-apply
  repository skills the manifest already records, and a tree whose content moved re-asks at
  Review. An untrusted repository contributes no source and no rows.

- Plugin drivers are lazy and use `driver:<namespaced-id>`. Aura never calls them during a
  workspace scan, `check`, `setup --yes`, or the post-setup rescan. Interactive setup lists a driver
  only when Skills opens, once per run; back navigation reuses the listing. Resolution batches all
  selected IDs for one driver and memoizes each success or failure.
- A driver is the one source kind that runs code, and it is not gated behind the private-source
  approval question. That question exists to authorize sending a **credential** to a host, which a
  driver never does; a driver is build-time code the distribution compiled in, already trusted to
  the same degree as the binary running it. What the user is owed is therefore visibility rather
  than a veto: the driver is named on its loading row while it runs, and the origin it declares for
  each skill is attributed to it at the review.
- Every driver call is bounded. The protocol has no cancellation, so the bound is on Aura's wait,
  not on the driver's work: a `list` or `resolve` that has not returned within 30 seconds is treated
  as unavailable and the step continues. The abandoned call cannot hold the process open.
- A skill source removed by a plugin's `disabledSkillSources` is reported as a first-visit note
  naming the plugin that removed it, because a row that is simply absent is indistinguishable from
  one that broke. A denylist entry naming a source this distribution never had says nothing.

- Before the picker opens, directory indexes load inside the wizard instead of leaving an empty
  terminal gap. The normal top-level flow row stays visible with Skills active, and the body shows
  one status row per approved asynchronous source: pending `☐`, an animated spinner while its
  request is active, then `✔`. The existing four-request concurrency limit still applies. A
  memoized listing skips this frame entirely when navigating back through the flow. The frame holds
  the terminal the way a form does — raw mode, cursor hidden — so keys struck while waiting are
  discarded rather than echoed into the animation or replayed into the picker behind it.
- AgenticSkills listings trust the provider feed at list time; Aura never holds the picker behind
  one `SKILL.md` request per advertised row. Once the feed is available, Aura groups its entries by
  GitHub `(owner, repository, ref)` and starts one bounded recursive-tree request per repository in
  the background. A complete tree that lacks an advertised root `SKILL.md` repaints that row in
  place as disabled with `— source no longer publishes this skill`. Tree results that land before
  the picker subscribes are retained and reflected in its first frame.
- Repository-tree verification is advisory. A request that fails, exceeds the response bound,
  returns malformed data, or carries GitHub's `truncated: true` marker keeps trusting the feed for
  that repository; it never falls back to per-entry probes. Resolution remains authoritative, so
  selecting a row before it is disabled still produces one failed Review row for that skill.
- Directory catalogs read through an on-disk cache (`~/agents/.cache/skill-catalogs`). A copy
  fresher than an hour serves with no request and says so in a first-visit note naming its age
  and `--no-cache`; a staler copy revalidates with `If-None-Match` and serves silently on a 304;
  and an unreachable source falls back to the newest copy under a week old, with a note naming
  its age — a dated listing beats an empty picker. Every cached body passes the same validation
  as a live one. Private directories are never cached: their listings are credential-gated
  content, and the cache is not. `--no-cache` bypasses reads and writes for catalogs and presets
  alike.
- The picker groups rows by source (`option.group`); a source that cannot be listed renders one
  disabled row with the reason in place (`Acme Skills — unavailable (set ACME_SKILLS_TOKEN)`),
  ahead of the installable rows so the initial row window can never hide it, and a manifest entry
  whose source is gone or disallowed renders disabled as `<id> (preserved)` / `<id> (blocked)` —
  clearing it is how the skill is removed.
- A source that advertises more entries than the listing cap renders one disabled row in the same
  leading position naming both numbers (`Acme Skills (truncated)` — `showing 10000 of 12000
entries — the rest cannot be listed until the catalog narrows upstream`). Truncation is never
  only a diagnostic note: a catalog quietly missing its tail reads as a catalog with nothing more
  to offer.
- A picker with more than ten rows opens on the user's own selection, not an alphabetical page:
  every checked row leads under one `Selected (N)` heading, followed by a browse window of the
  next unchecked rows. That window carries up to ten rows the reader can check and up to ten
  disabled rows alongside them, both in display order — a disabled row costs its own position and
  never someone else's, so a catalog whose alphabetical head is a run of unavailable or no-longer
  published rows can never open on a frame where nothing can be checked. A multiselect's search
  status line always carries a live `· N selected` count while anything is checked, so the size of
  the basket is never off screen.
- The `/` action, labelled `Search all <n> skills`, filters locally across names, ids,
  descriptions, and sources — ranked, not merely filtered: a term starting a word of the label
  beats a substring inside it, which beats a hit in the id, the source, or the description, and
  ties keep display order. Matched spans render bold. At most fifty matches render per query; the
  status line then reads `showing 50 of <n> matches — keep typing to narrow`, so the cap is never
  silent. Checked rows the query does not match stay on screen under a trailing
  `Selected, not matching this filter (K)` heading — marking a row must never make it disappear.
  `↵` leaves search editing for result navigation, and `esc` clears an active search before it can
  cancel the form. While the query has focus the hint line names those bindings instead of the
  standing ones: `type to filter · ↑/↓ move · ↵ results · esc clear search`.
- On a searchable multiselect, `s` narrows the rows to the checked ones (status line
  `s Showing only selected rows · s show all`), a second press restores the full view, and
  opening `/` clears the filter — the two narrowings never compose. The standing hint carries an
  `s selected` segment exactly where the filter is available.
- Plugin-shipped presets that declare a skill selection appear as **skill packs**: one row per
  preset under a `Skill packs` group ahead of the catalog rows, labelled
  `<name> — <n> skills`. A pack is a selection gesture, not a lock or a policy layer: space on it
  checks every member row the catalog offers this run (or clears them all when every one is
  checked), each member stays individually toggleable, a partially checked pack renders `◪` with
  `(K of N selected)` in place, and its own value never enters the answer. Every remote member
  still passes its own Review with Skip standing, so `--yes` takes nothing from a pack. A pack
  none of whose members are offered renders disabled (`— no member is available in this run`);
  a preset that fails to read or validate is dropped with a first-visit note naming it; a preset
  with no skill selection is a policy document, not a pack, and is skipped silently. The pack
  reads only the preset's `skills` list — directories, checks, and required servers apply only
  when the preset is configured as the run's policy layer.
- A provider catalog may advertise its own curated selections (`collections` in its feed), which
  render in the same `Skill packs` group with their provenance in the description
  (`· catalog collection` vs `· plugin preset`). A collection is data from a remote host, never
  policy: it can only pre-check rows that catalog already serves — members it does not advertise
  are dropped at parse time, malformed collections vanish without a diagnostic, and every member
  still passes its own Review. At most 32 collections of 200 members each are read.
- `p` works at the picker, not only at Review: a remote row fetches its own SKILL.md on demand —
  the overlay opens on `Loading the preview…` and repaints with the body — because reading a
  skill is exactly how someone decides whether to check its row. The fetch is bounded, memoized
  into the same pack cache the Review resolution reads (so previewing never costs the install a
  second download), and a fetch that fails shows its validated reason in the overlay without
  changing the row. A bundled row keeps its packaged content; `--yes` and scripted runs never
  press `p`, so nothing is ever fetched for them.
- A remote skill's Review row names the source, version, and origin of its bytes, not the directory
  that advertised it: a catalog indexing content elsewhere reports that origin
  (`https://github.com/<owner>/<repo>/tree/<ref>/<dir>`), because approving a skill is approving
  the host it comes from. For a directory that origin is where the bytes were fetched from. A
  driver instead hands Aura a local directory, so its origin is the one the driver **declares** for
  the content — a claim attributed to the driver, not a host Aura observed serving it.
- The picker prompt ends with a support matrix for the applications selected in the Apps step, in
  adapter order (`Apps: ✓ Claude Code · ✓ Codex · — Cursor`). It is stated once above the rows
  rather than per row, because it describes the run and not any one skill. An adapter's declared
  Agent Skills capability supplies the cell; a managed id this build does not ship cannot be read
  either way and appears afterward as `? <id> (not in this build)`.
- When no selected application supports skills, the prompt says so in place of the question and
  new rows are disabled with the note `no selected app supports skills`. An installed row stays
  pre-checked while disabled, so it is preserved by default but can still be cleared for the
  guarded uninstall path. Picks made before the Apps answer changed are cleared with a note
  naming them, never silently. `setup --add skill` additionally requires an established manifest
  and either a managed application that supports Agent Skills or a skill already recorded to
  remove.
- A disabled row states its own reason after the label (`— source unavailable`,
  `— blocked by the team preset`, `— no selected app supports skills`); `— unavailable` is the
  default only where no more specific reason applies.
- A Review form appears for a directory skill that is new to the manifest or whose upstream
  content changed, and for a bundled skill whose recorded revision no longer matches the installed
  plugin's. It is a select between `Skip` and one of `Install <id> <version>`,
  `Update to <id> <version>`, or `Switch to <id> <version>`; the install row's description is the
  source URL and its preview is the full SKILL.md. `Switch to` names a revision that is not newer —
  a rollback, or a pair of versions this build cannot order — so a move backward is never labelled
  an upgrade. **Skip is always the initial answer**, so `--yes` and exhausted scripts can only
  re-apply skills the manifest already records — a non-interactive run never first-installs remote
  prompt content, and never changes the revision of content it already manages.
- Installs from a source the active `allowedSkillSources` does not permit are refused at
  planning time with a blocker naming the policy source
  (`Skill "<id>" comes from <source>, which the team preset "<origin>" does not allow.`), which
  also covers `--add skill` and manifest entries whose source lost its permission. `<origin>` is
  the preset as resolved — `npm:@acme/preset@1.2.0` or an HTTPS URL — and a policy supplied by
  the repository's own file is named `repository preset ".aura/preset.json"`, so a policy is
  never presented as coming from somewhere it did not.
- A driver listing or resolution failure leaves every manifest-recorded selection checked and
  unavailable. One failed source or skill does not hide other entries. Diagnostics use validated
  IDs and generic reasons only; raw errors, environment values, rejected paths, and file contents
  appear nowhere outside the explicit `p` review preview.

### MCP step

A picker over every catalog and configured MCP server, then one form per selected server
capturing its name and applications. Every selection is personal/global. Runs after Skills, before
Baseline.

- Rows merge four sources: catalog definitions contributed by installed plugins, definitions a
  trusted repository preset provides inline (`provides.mcpServers`, ids namespaced `repo/<name>`),
  entries the manifest already records, and custom servers added during the step. A row's
  description names its provenance (`Plugin: Aura Official Content`,
  `Repository: .aura/preset.json`, or `Custom server`), and its label carries what the run knows
  about it — `(from preset, required)`, `(from repo, required)`, `(from repo)`, `(configured)`,
  `(custom)`. Required rows sort first (whoever required them), then the repository's own
  definitions, then configured ones, then the rest by name — the repository leads the optional
  block without outranking a requirement it did not make.
- The last row is always `Add a custom server…`. Choosing it opens the transport forms — a select
  between `Command (stdio)` and `Remote URL (HTTP)`, then the fields for that transport — and
  returns to the same picker with the new row checked. A catalog row never asks for a transport:
  its definition supplies one.
- Transport fields take JSON as typed (`["--serve"]`, `{"Authorization":"Bearer ${TOKEN}"}`) and
  are re-seeded with the draft on rejection. A rejected value is reported as the field it belongs
  to plus Aura's reason (`Custom MCP transport $.headers must contain a ${VARIABLE} reference.`);
  the value itself is never echoed, and the header name the path would carry is collapsed into
  `$.headers` before it reaches the terminal. **A header value carries `${VARIABLE}` references and short
  framing text only** — a credential typed into the form is refused, not stored.
- The per-server form disables an application row with its reason in place (`— not detected`,
  `— not managed by Aura`, `— adapter cannot write MCP configuration`,
  `— not supported by this catalog server`, `— installed version is unsupported`). An application
  the manifest targets that this build does not ship stays checked but disabled
  (`— adapter is not available in this build`).
- A name is refused when it is unusable as a configuration key, and when another server selected in
  this run already claims it for one of the same applications — that pair is one
  key in one file, and the manifest declines to record two of them. Added custom servers are named
  `custom`, `custom-2`, … so accepting the defaults is never that collision.
- **A preset-required server the manifest does not already record is pre-checked only for an
  interactive run.** `--yes` and exhausted scripts re-apply what the manifest records and nothing
  more; the unmet requirement becomes a blocker naming the interactive run
  (`Required MCP catalog entry official/github is not configured yet. Run setup interactively…`).
  This is the skills-step rule applied to a credential-bearing remote endpoint: a non-interactive
  run never first-configures one on a repository's say-so. The same rule covers repository
  definitions exactly: a repository may require its own server by listing `repo/<name>` in
  `requiredMcpServers` — interactively that row opens pre-checked at the very top; under `--yes`
  it is the same named blocker, never a silent install. A provided-but-not-required repo row is
  never pre-checked; it merely leads the optional rows. A trusted repository server definition is
  an input to the user's global desired state; Aura never installs it into repository files.
- Interactively, clearing a required row asks for one explicit confirmation
  (`Override the team preset on this machine and omit official/github?`), and re-checking the row
  clears the override. Only a run that resolved the preset rewrites the recorded overrides, so an
  offline run leaves a confirmed deviation in place rather than reading a failed fetch as a
  withdrawn requirement. A required id the installed plugins do not provide is a blocker naming the
  preset, never a silent omission.
- ← from any per-server form returns to the picker with every answer of that pass intact,
  including a custom transport, which becomes editable again on the return trip.
- Credentials are never read by the step. A variable a selected transport references and the
  environment does not set becomes a manual step after the plan
  (`A GitHub personal access token… Set it in GITHUB_PERSONAL_ACCESS_TOKEN. Configure it at …`),
  and MCP-003 reports the same gap on later runs. Only the name and whether it is set are ever
  held.
- `setup --add mcp` requires an established manifest and either a managed application that
  supports MCP configuration or a server already recorded to remove.

### Plan summary notices

Above the manual steps, the summary groups what the plan did not simply write, each group under one
heading and one `·` bullet per line:

```
Hand edits Aura is replacing:
Preserved content Aura does not own:
Managed content kept at its recorded revision:
Selections Aura could not apply:
Effective check policy from preset <name> (not copied into your manifest):
Effective check policy from the repository preset .aura/preset.json (not copied into your manifest):
Repository preset held (not trusted on this machine):
```

- A group naming a shared source names it once, in the heading. Repeating "(from preset acme)" on
  every line hides the settings the line is actually there to show.
- The held group keeps a non-interactive run honest: every skill left at its recorded revision is
  listed with the version that is waiting, so a `--yes` run that declined a dozen skill updates
  cannot read as a run with nothing to do.
- The skipped group is where a selection Aura could not act on lands — a snippet whose plugin no
  installed build provides, above all. It is a notice and not a blocker on purpose: nothing about
  the state of a file is refusing the write, and failing the run would strand every selection that
  did resolve alongside the one that did not.

### Implementation status

The bar maps the whole flow in two rows: the orchestrator threads a `WizardFlowContext`
(completed steps, the active `step`, upcoming steps) into every form a step opens (`gather.ts`),
and `runFormChain` adds the live `sub` progress per ask (`wizard-chain.ts`), so the top row stays
static while the sub-row tracks the step's internal forms. The final "Apply this plan?"
confirmation is the flow's Submit: its flow carries no `step`, so it renders through the
single-row path as `✔ …every step… │ ▶ Submit`. Anatomy, glyphs, Submit locking, width
degradation, and back navigation are implemented in `wizard-render.ts` / `wizard-tabs.ts` /
`wizard-form.ts` / `wizard-chain.ts` / `setup.ts`: a form resolving `"back"` rewinds the step's
internal chain, a step resolving `SETUP_BACK` re-runs the previous step seeded from this run's
selections, and the confirmation's back re-runs the last step before re-planning.

Accepting the confirmation applies the plan against the file contents planning read moments
earlier. When a configuration file changed during the pause — another process rewriting
`~/.claude.json` is the common case — the apply fails safe, and setup re-plans the same
selections from a fresh read and applies again (at most twice) without re-asking, printing
exactly one line on that path:

```
A configuration file changed while you were confirming; re-planning against its current contents.
```

The normal path prints nothing new, so captured output stays byte-stable. When the retries are
exhausted, or the re-plan itself comes back blocked, the run fails exactly as it did before the
retry existed.

Frames are also windowed to the terminal: a question body taller than the viewport is clipped
around the cursor with dim `↑/↓ N more` markers (capacity is the viewport minus four chrome rows
minus one per bar line), because the engine repaints by cursor-up erasure and an overflowing
frame would leak rows into the scrollback. The clip window is measured in wrapped display rows,
not logical lines — a label wider than the terminal counts for every row it wraps onto. Width
arithmetic counts display columns, not code points (East Asian and emoji characters occupy two),
and wrapping advances a grapheme cluster at a time, so an emoji written as a base plus a modifier
counts the two columns it occupies rather than two per code point.
A terminal resize repaints immediately against the new viewport, erasing with the larger of the
old row count and the painted frame recounted at the new width, so a shrink leaves no artifact
rows behind.

The opening scan starts in `boot.ts` and reaches its loading frame through `scan-loading.ts`,
which buffers adapter progress reported before the frame exists and replays it on open; the
frame itself is the shared loader (`wizard-loader.ts`).

One refinement remains open: a _multi-question_ form reopened via back lands on its first
question tab (backing into duplicates opens Duplicate 1, not Duplicate 4).
