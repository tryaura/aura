# Coding-agent session health brief

You are auditing the health of recorded coding-agent sessions on this machine. The
aggregates below were computed deterministically from Codex transcripts of the last 30
days (since 2026-07-26). Follow the investigation steps and produce the output
described at the end. Do not re-scan the transcript tree; read only the pointed lines.

## Overall

- 447 sessions in 3 projects · 309h 38m wall · 47h 41m waiting on tools
- 29,945 tool calls, 571 failed (2%)

## Project: family_planner

- 228 sessions across 99 directories · 221h 39m wall · 36h 36m in tools
- 20,193 tool calls, 569 failed · 118 compactions · 1 transcript truncated (counts are lower bounds)
- Tokens: 2.5B in (97% cached) · 5.2M out
- `pnpm` failed ×143, mostly exit 1
  - evidence: /Users/pmikolajczuk/.codex/sessions/2026/07/30/rollout-2026-07-30T21-07-02-019fb46c-4514-7ab2-95df-eb1dc37c40e3.jsonl:138
  - evidence: /Users/pmikolajczuk/.codex/sessions/2026/07/30/rollout-2026-07-30T21-09-25-019fb46e-72fb-7413-bf10-d8223a0f9d77.jsonl:679
- `sed` failed ×28, mostly exit 1
  - evidence: /Users/pmikolajczuk/.codex/sessions/2026/07/29/rollout-2026-07-29T21-56-32-019faf73-3b0d-7272-97ee-194d4a2a23cb.jsonl:45
  - evidence: /Users/pmikolajczuk/.codex/sessions/2026/07/30/rollout-2026-07-30T12-33-21-019fb295-faed-7d92-84fb-7598c6c83764.jsonl:3413
- `gh` failed ×27, mostly exit 8
  - evidence: /Users/pmikolajczuk/.codex/sessions/2026/07/30/rollout-2026-07-30T12-33-21-019fb295-faed-7d92-84fb-7598c6c83764.jsonl:2738
  - evidence: /Users/pmikolajczuk/.codex/sessions/2026/07/30/rollout-2026-07-30T12-33-21-019fb295-faed-7d92-84fb-7598c6c83764.jsonl:3586
- Trouble concentrates in:
  - /Users/pmikolajczuk/conductor/workspaces/family_planner/san-francisco-v2 — 4 sessions, 63 failed calls, 7 compactions
  - /Users/pmikolajczuk/conductor/workspaces/family_planner/copenhagen-v1 — 2 sessions, 51 failed calls, 8 compactions
  - /Users/pmikolajczuk/conductor/workspaces/family_planner/chennai — 5 sessions, 14 failed calls, 21 compactions

## Project: aura

- 216 sessions across 95 directories · 87h 45m wall · 11h 3m in tools
- 9,737 tool calls, 2 failed · 28 compactions
- Tokens: 1.2B in (97% cached) · 4.5M out
- Trouble concentrates in:
  - /Users/pmikolajczuk/conductor/workspaces/aura/bratislava-v1 — 6 sessions, 1 failed call, 2 compactions
  - /Users/pmikolajczuk/conductor/workspaces/aura/edinburgh — 6 sessions, 0 failed calls, 2 compactions
  - /Users/pmikolajczuk/conductor/workspaces/aura/houston — 2 sessions, 0 failed calls, 2 compactions

## Investigate

1. For each failing command, read its evidence lines. Each pointer is a 1-based line in a
   JSONL transcript; the failing output is in that record's `payload.output` field (for
   example: `sed -n "<line>p" <file> | head -c 4000`). Classify the root cause: broken
   environment, wrong command for this project, or the command running correctly but its
   checks failing.
2. Visit the trouble-concentrating directories that still exist (skip deleted ones). Read
   their agent instruction files (`AGENTS.md`, `CLAUDE.md`) and `package.json` scripts.
   Check whether the instructions match what the sessions actually ran, and whether the
   failing commands are misdocumented, missing setup steps, or missing entirely.
3. For projects with many compactions, judge from the instruction files whether sessions
   are told to read too much, and what guidance would keep tasks inside one context window.

## Output

Produce ranked findings, most impactful first, at most five. For each: the project, the
root cause in one sentence, the evidence you used, and a concrete fix — when the fix is an
instruction change, write the exact lines to add or change in that project's instruction
file. End with anything you could not diagnose and what would be needed. Keep the whole
answer under 60 lines.
