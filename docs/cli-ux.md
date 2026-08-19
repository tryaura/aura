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
3. **Plumbing is demoted, never hidden.** Flags that exist for tests and CI (`--home`, `--path`)
   sit last under "Advanced". They stay documented — honesty over minimalism — but they never
   compete with the everyday path.
4. **Glyphs carry state; color only reinforces it.** Output must disambiguate on a monochrome
   terminal (`▶` active, `✔` done, `☐` pending). Color and bold/inverse/dim are enhancements,
   never the only carrier of meaning. `NO_COLOR` disables color entirely; injected (non-TTY)
   streams get zero escape sequences, so captured output is byte-stable.
5. **One machine-readable seam.** `--json` emits exactly one parseable document on stdout;
   everything else the run produces moves to stderr. Human output never leaks into the document.
6. **Branding is injected.** Screens render from `CliBranding` (`command`, `displayName`,
   `version`, `description`, `docsUrl`) so every distribution gets correct help for free. Parts a
   distribution does not define are dropped, not placeholder-filled.

## Help surface

Rendered by `packages/cli/src/help.ts`; exact layouts pinned in `help.test.ts`.

- `aura` / `aura --help` / `aura -h` — root screen: Get started → Everyday use → Help, then a
  `Docs:` footer when branding defines one. The Help section lists `aura <command> --help`, and an
  `aura --version` row exactly when branding carries a version (which is also when the flag is
  registered at all).
- `aura check --help` — Everyday use, Narrow it down, Fixing behavior, Scripting, Advanced, then
  the exit-code footer.
- `aura setup --help` — Everyday use, Options (including every registered `--add` kind),
  Advanced, then a footer pointing at `check`.
- `aura undo --help` — Everyday use, Options, Advanced, then the restore exit-code footer.
- `aura <typo>` — `aura: unknown command '<typo>'`, the command list, and a pointer to `--help`.
  Exit code 2. A bad _flag_ on a real command keeps clipanion's own message, which names the
  offending flag.

Layout rules: terms align to one shared column across the whole screen; section titles are
indented two spaces, rows four; no boxes, rules, or banner lines; no trailing periods on row
descriptions. Clipanion's default help renderer is bypassed entirely (`runCli` intercepts the
internal help command and unknown-command errors).

## Exit codes

`0` clean/info · `1` warnings · `2` errors or usage/state conflicts · `3` operational failures.
Every command returns one of these; `runCli` normalizes anything else to 2.

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
 └ ✔ Global │ ▶ Sources ☐ │ Duplicates ☐ │ Archive ☐
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
  `✔ Global │ ✔ Sources │ ✔ Archive │ ▶ Project ☐ │ Sources ☐`.
- The Project action offers a final `Skip project instructions` option that the Global action does
  not: declining the global scope would leave the shared-source and application-link checks failing,
  so setup could not end on green. A declined scope contributes only its action tab — no Sources,
  Duplicates, or Archive tabs follow it, by the same honest-map rule:
  `✔ Global │ ✔ Sources │ ✔ Archive │ ▶ Project ☐`.
- Declining is not undoing, and the option says so where it matters: when the project target already
  has content, the option's description names the file and states that it, and anything linking to
  it, stay as they are. Otherwise the only thing a skip-only run would say about an earlier run's
  target and link is that everything had already converged.
- The same reasoning binds the answers a scope can settle on, not just the ones it is shown: an
  action that was not on that scope's menu falls back to the proposed one, and a Global scope whose
  Sources form ends up empty is a blocker rather than a silent decline through the back door.
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
  backward opens on its **last** form (← from Snippets lands on Archive, not Global), a step with
  nothing to ask passes ← straight through, and the final confirmation backs out into the last
  step the same way. Informational banners print only on a step's first visit.
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
  (↑/↓ move, space toggles, digits jump, ↵ answers and advances).
- Footer hint line: `↑/↓ move · space toggle · ←/→ steps · ↵ select · esc cancel` (segments
  appear only when applicable; a locked Submit drops `↵ submit`).
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

### Skills step

A picker over every allowed skill source, then one Review form per selected directory skill.

- The picker groups rows by source (`option.group`); a source that cannot be listed renders one
  disabled row with the reason in place (`agenticskills.io — unavailable (set ACME_SKILLS_TOKEN)`),
  and a manifest entry whose source is gone or disallowed renders disabled as
  `<id> (preserved)` / `<id> (blocked)` — clearing it is how the skill is removed.
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
- Installs from a source the team preset's `allowedSkillSources` does not permit are refused at
  planning time with a blocker naming the preset
  (`Skill "<id>" comes from <source>, which the team preset "<origin>" does not allow.`), which
  also covers `--add skill` and manifest entries whose source lost its permission. `<origin>` is
  the preset as resolved — `npm:@acme/preset@1.2.0`, an HTTPS URL, or `.aura/preset.json` — never
  the conventional path standing in for a policy that came from somewhere else.

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
question tab (← from Archive opens the duplicates form on Duplicate 1, not Duplicate 4).
