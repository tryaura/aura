# CLI UX contract

How Aura's command line looks and behaves, and why. The renderers in
`packages/cli/src/help.ts` and `packages/cli/src/setup/wizard-render.ts` implement this contract;
the inline snapshots in their test files pin the exact bytes. Change this document and the
implementation together.

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

Rendered by `packages/cli/src/help.ts`; exact layouts pinned in `help.test.ts`.

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

## Exit codes

For `check`: `0` completed check, regardless of finding severity · `2` usage/state conflicts or no
checks · `3` operational failures. Finding health remains visible through the report status and
severity counts. Setup and undo also use `1` for incomplete user-driven flows. `runCli` normalizes
any other code to 2.

## Glyph vocabulary

| Glyph | Meaning                                          |
| ----- | ------------------------------------------------ |
| `▶`   | Active tab/step                                  |
| `✔`   | Completed step                                   |
| `☐`   | Pending step, or an unchecked multiselect option |
| `☑`   | A checked multiselect option                     |
| `◪`   | A pack row with some, not all, members checked   |
| `●`   | The currently selected option of a select        |
| `○`   | An unselected select option                      |
| `❯`   | Cursor row inside a question body                |
| `│`   | Tab separator                                    |
| `└`   | Sub-row connector under the active step          |
| `·`   | Separator inside hint lines and footers          |

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
 └ ✔ Global │ ▶ Sources ☐ │ Duplicates ☐
```

- The live form's questions appear individually (`▶ Duplicate 2 ☐`); a completed or upcoming
  stage collapses to its stage label (`Duplicates`).
- The sub-row has no Submit of its own; its inactive tabs render dimmed where the terminal
  supports it — on monochrome the `└` prefix alone carries the hierarchy.
- The sub-row is an honest map: a conditional stage appears the moment its precondition holds and
  disappears when it stops holding. A stage behind the live form shows `☐` even when a
  remembered answer will re-seed it.
- Both instruction scopes flow through one sub-row; the `Global` / `Project` action tabs double
  as scope section markers, so repeated stage names read unambiguously left to right:
  `✔ Global │ ✔ Sources │ ▶ Project ☐ │ Sources ☐`.
- The Project action offers a final `Skip project instructions` option that the Global action does
  not: declining the global scope would leave the shared-source and application-link checks failing,
  so setup could not end on green. A declined scope contributes only its action tab — no Sources or
  Duplicates tabs follow it, by the same honest-map rule:
  `✔ Global │ ✔ Sources │ ▶ Project ☐`.
- A scope whose target already holds instructions and whose scan found nothing to merge into it is
  settled: it contributes no tabs to the sub-row, and the step states what it found instead of
  asking a question whose every answer either changes nothing or overwrites text Aura did not write.
- Declining is not undoing, and the option says so where it matters: when the project target already
  has content, the option's description names the file and states that it, and anything linking to
  it, stay as they are. Otherwise the only thing a skip-only run would say about an earlier run's
  target and link is that everything had already converged.
- The same reasoning binds the answers a scope can settle on, not just the ones it is shown: an
  action that was not on that scope's menu falls back to the proposed one, and a Global scope whose
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
  first with the opt-out last. A scope with nothing to combine recommends nothing, and its menu is
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

- Interactive `setup` asks once, before the wizard opens, after one note naming the preset and a
  validated capability summary. The summary lists required MCP servers, allowed skill sources,
  selected skills and snippets, and every skill-directory URL (plus its token variable), so
  repository-controlled network endpoints are visible before consent. Check policy spells out each
  enabled or disabled check, severity, and threshold before the prompt, for example
  `Checks: SEC-001: disabled; TOK-001: thresholds {"approxTokens":12000}`. The effective values also
  print in the plan summary's read-only policy group once the layer applies. The opening note is
  `This repository provides the preset "<name>" at .aura/preset.json.` The prompt is
  `Trust the repository preset at .aura/preset.json? Its settings apply to every Aura run in this
repository until the file changes.` Inside a linked worktree the prompt is preceded by one more
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
- Trust binds to exact contents, and to the repository rather than the directory. A file that
  changes after acceptance is untrusted again, and the next interactive setup re-asks as a change,
  never as a first sighting (`The repository preset at .aura/preset.json changed since you trusted
it. Trust the new contents?`) — that wording is keyed to the file in front of the user, so a
  sibling worktree carrying different contents is a first sighting, not a change. A linked worktree
  holding contents already accepted for its checkout applies them without asking, since anyone who
  can write the file in one worktree can write it in all of them. Each distinct set of contents a
  repository's user accepted keeps its own entry, so reverting the file to an earlier accepted
  revision does not re-ask.
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
  down.
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
capturing its name, scope, and applications. Runs after Skills, before Baseline.

- Rows merge three sources: catalog definitions contributed by installed plugins, entries the
  manifest already records, and custom servers added during the step. A row's description names
  its provenance (`Plugin: Aura Official Content`, or `Custom server`), and its label carries what
  the run knows about it — `(preset required)`, `(configured)`, `(custom)`. Required rows sort
  first, then configured ones, then the rest by name.
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
  this run already claims it at the same scope for one of the same applications — that pair is one
  key in one file, and the manifest declines to record two of them. Added custom servers are named
  `custom`, `custom-2`, … so accepting the defaults is never that collision.
- **A preset-required server the manifest does not already record is pre-checked only for an
  interactive run.** `--yes` and exhausted scripts re-apply what the manifest records and nothing
  more; the unmet requirement becomes a blocker naming the interactive run
  (`Required MCP catalog entry official/github is not configured yet. Run setup interactively…`).
  This is the skills-step rule applied to a credential-bearing remote endpoint: a non-interactive
  run never first-configures one on a repository's say-so.
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
