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
  `Docs:` footer when branding defines one.
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
 ✔ Applications │ ▶ Instructions ☐ │ Snippets ☐ │ Baseline ☐ │ Submit
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
- A step whose single form is named like the step shows no sub-row.

Tab states, in either row:

- Active tab: `▶ ` prefix (plus inverse where the terminal supports it). Never a box around the
  active tab.
- Pending: trailing `☐`.
- Completed: leading `✔`, no checkbox (`✔ Applications`).
- Submit: label only — no `☐`/`✔`. It is an action, not a step. When active it gets the same
  `▶ ` prefix; while locked it renders dimmed.

### States & navigation

- ←/→ (and tab) move focus across the live form's tabs, and past its ends they move through the
  flow: ← past the first tab _backs out of the form_ — the previous form reopens with the answers
  it was given, all the way back to the first step — and → past the last tab _commits the form as
  it stands and advances_, so a backed-into flow retraces forward without re-answering. On the
  Submit confirmation → is inert; applying a plan is always an explicit ↵. A step re-entered
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

1. Compact labels (`WizardQuestion.compactLabel`: `Apps`, `Base`, `Dup 1`, …).
2. Glyph-only for non-active tabs (`✔ │ ✔ │ ▶ Snippets ☐ │ ☐ │ Submit`) — the active tab always
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
frame would leak rows into the scrollback. Width arithmetic counts display columns, not code
points (East Asian and emoji characters occupy two), and a terminal resize repaints immediately
against the new viewport.

One refinement remains open: a _multi-question_ form reopened via back lands on its first
question tab (← from Archive opens the duplicates form on Duplicate 1, not Duplicate 4).
