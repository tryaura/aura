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

- `aura` / `aura --help` / `aura -h` — root screen: Get started → Everyday use → Help → Advanced,
  then a `Docs:` footer when branding defines one. The Help section lists `aura <command> --help`,
  and an `aura --version` row exactly when branding carries a version (which is also when the flag
  is registered at all). Advanced carries `--no-color` alone.
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

Human check output is action-first. The concise default renders the human verdict and severity
counts, the one command that can address the available fixes, then Available fixes, Manual
attention, and Suggestions. Informational findings are suggestions, never manual work. Passed
checks and detected applications collapse into one summary line.

Checks may declare a plugin-namespaced `findingGroup` with an action-oriented title and
description. Findings sharing that group render under one heading that states the remediation
once — but a group summarizes the _fix_, never the _evidence_: every member is still named on its
own line beneath it, with its own detail and locations, so no run reports a count where it could
report a file. The concise default caps that list at three occurrences and two locations each and
says how many more are waiting. A grouped heading always carries its member count, including at one member, so
the halves of a group split across remediation sections stay recognizable as one problem. Checks
without a group remain individual, so an older plugin never loses its message. Check IDs appear
below the human copy as secondary metadata rather than leading a line, and the closing More section
carries the `--explain <id>` that turns one into a full explanation.

Human output has a hard ceiling of 100 findings total, selected errors first, then warnings, then
suggestions while preserving plugin order within a severity. It names any omitted tail, and a
truncated section heading carries both numbers (`Suggestions (98 of 100)`) so it never contradicts
the fix count in the recommended next step, which always speaks for the whole run. Each shown
finding likewise has a hard ceiling of 100 locations, and one location line is bounded in length
the same way a finding's message is. Whenever either ceiling truncates, the More section points at
`--json`, which remains untruncated — no report offers `--verbose` for detail the ceiling has
already dropped.

`--verbose` lifts the concise three-occurrence and two-location caps up to those safety ceilings and
adds metadata tables, passed checks, and applications. It does not restore a severity-first ledger.
Indentation carries the
hierarchy: group heading at two spaces, its shared description and check ids at four, each
occurrence at four, and that occurrence's own detail and locations at six. Project paths render
relative to the project root (the invocation directory outside a repository), home paths use `~/`,
and other paths remain absolute — one shared helper (`@tryaura/core/display-path`) serves both the
CLI's location lines and the paths checks bake into their messages, so a report cannot name the
same file two ways. `--verbose` works with scans and fixes but not with `--json` or `--explain`;
`--detail` remains the separate gate for potentially sensitive plugin failure text.

The summary line above the sections reports what was inspected, not a verdict: it takes a green `✓`
only when at least one check passed, and a plain `·` when the run inspected nothing.

The report recommends `aura check --fix` for every fixable finding, automatic and guided alike, and
names the split ("Review 5 available fixes: 5 guided") so the user knows whether the run will ask
them anything. An operationally incomplete scan recommends neither because its findings may be
incomplete.

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
| `●`   | The currently selected option of a select        |
| `○`   | An unselected select option                      |
| `❯`   | Cursor row inside a question body                |
| `│`   | Tab separator                                    |
| `└`   | Sub-row connector under the active step          |
| `·`   | Separator inside hint lines and footers          |

Plain ASCII/Unicode only — no spinner frames, no emoji.

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
- Declining is not undoing, and the option says so where it matters: when the project target already
  has content, the option's description names the file and states that it, and anything linking to
  it, stay as they are. Otherwise the only thing a skip-only run would say about an earlier run's
  target and link is that everything had already converged.
- The same reasoning binds the answers a scope can settle on, not just the ones it is shown: an
  action that was not on that scope's menu falls back to the proposed one, and a Global scope whose
  Sources form ends up empty is a blocker rather than a silent decline through the back door.
- **Consolidating is a migration, not a copy**, and every surface that offers it says so: the
  option's description, and a footer line on `setup --help`. The sources it merges are backed up
  and taken off disk in the same plan, and `undo` restores them. `Keep existing shared file` leads
  the menu wherever there is a target to keep, so this is what `--yes` takes only on a machine that
  has no shared file yet — the run that has nothing to overwrite, and the one whose plan summary
  lists every move before applying it.
- A source the merge could not place is the exception: its provenance heading is already in the
  target, so nothing new was appended, and the file has changed since. Archiving it would delete
  the only copy of what it now says, so it stays where it is and the run names it under _Steps to
  take yourself_ until someone resolves the divergence.
- The Skills step is the second chain precedent: its Review stage exists only while a directory
  skill is selected or a recorded skill's source revision moved, one review question per skill —
  `└ ✔ Skills │ ▶ Review claude-md ☐ │ Review commit-style ☐`.
- The Snippets step follows the same shape: a picker, then a Review stage carrying one question per
  selected snippet whose source revision no longer matches the recorded one —
  `└ ✔ Snippets │ ▶ Review official/rules ☐`. ← from a review returns to the picker with that
  pass's ticks intact; it leaves the step only from the picker itself, because backing out of a
  review would discard both the selection just made and every review already answered.
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
  already-marked one can still be cleared. Digits jump to a row and mark it the same way.
- Footer hint line: `↑/↓ move · space toggle · ←/→ steps · ↵ select · esc cancel` on a
  multiselect, `↑/↓ move · space select · ←/→ steps · ↵ confirm · esc cancel` on a select
  (segments appear only when applicable; a locked Submit drops `↵ submit`).
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
- The picker groups rows by source (`option.group`); a source that cannot be listed renders one
  disabled row with the reason in place (`Acme Skills — unavailable (set ACME_SKILLS_TOKEN)`),
  ahead of the installable rows so the initial row window can never hide it, and a manifest entry
  whose source is gone or disallowed renders disabled as `<id> (preserved)` / `<id> (blocked)` —
  clearing it is how the skill is removed.
- A picker with more than ten rows initially renders only its first ten, plus any preselected rows
  outside that window so an installed or preset choice never disappears. Its `/` action, labelled
  `Search all <n> skills`, filters locally across names, ids, descriptions, and sources; while a
  query is active every matching row is rendered, with no ten-row cap. `↵` leaves search editing
  for result navigation, and `esc` clears an active search before it can cancel the form. While the
  query has focus the hint line names those bindings instead of the standing ones:
  `type to filter · ↑/↓ move · ↵ results · esc clear search`.
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
Effective check policy from preset <name> (not copied into your manifest):
Effective check policy from the repository preset .aura/preset.json (not copied into your manifest):
Repository preset held (not trusted on this machine):
```

- A group naming a shared source names it once, in the heading. Repeating "(from preset acme)" on
  every line hides the settings the line is actually there to show.
- The held group is what keeps a non-interactive run honest: every snippet and skill left at its
  recorded revision is listed with the version that is waiting, so a `--yes` run that declined a
  dozen updates cannot read as a run with nothing to do.

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

One refinement remains open: a _multi-question_ form reopened via back lands on its first
question tab (backing into duplicates opens Duplicate 1, not Duplicate 4).
