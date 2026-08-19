---
title: Desired-state manifest
description: The versioned ~/agents/aura.json protocol used to record what Aura manages.
---

Aura records its desired state and ownership ledger in `~/agents/aura.json`. This path is part of
the Aura protocol: distributions may change their command name and presentation, but they cannot
move or rename the manifest.

## Schema version 1

Every top-level section is required, including sections that are still empty:

```json
{
  "schemaVersion": 1,
  "preset": "plugin:official/platform",
  "checks": {
    "disabled": ["MCP-002"],
    "severity": { "INS-007": "error" },
    "thresholds": { "INS-007": { "approxTokens": 12000 } }
  },
  "apps": {
    "claude-code": { "managed": true }
  },
  "ignoredApps": ["cursor"],
  "snippets": [
    {
      "id": "official/commit-conventions",
      "version": "1.0.0",
      "hash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "pinned": false
    }
  ],
  "skills": [
    {
      "id": "review",
      "source": "plugin:official",
      "version": "1.0.0",
      "treeHash": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      "pinned": false
    }
  ],
  "mcpServers": [
    {
      "name": "github",
      "transport": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-github"],
        "env": ["GITHUB_TOKEN"]
      },
      "apps": ["claude-code", "cursor"],
      "scope": "global",
      "catalogId": "official/github"
    },
    {
      "name": "sentry",
      "transport": {
        "type": "http",
        "url": "https://mcp.example.com/sentry",
        "headers": {
          "Authorization": "Bearer ${SENTRY_TOKEN}"
        }
      },
      "apps": ["claude-code"],
      "scope": "project"
    }
  ],
  "overrides": {
    "requiredMcpServers": ["official/github"]
  },
  "trustedRepoPresets": [
    {
      "path": "/home/dev/projects/acme/.aura/preset.json",
      "hash": "456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123"
    }
  ],
  "ownership": {
    "claude-code": {
      "mcpServerNames": [],
      "files": ["~/.claude/CLAUDE.md#aura-block"]
    }
  }
}
```

`preset` is the sticky team preset reference used when `--preset` is absent. `checks` stores
per-user activation, severity, and threshold overrides. Both fields are optional for compatibility
with existing manifests, and `check` never persists either field automatically. `apps` records
which detected applications Aura should manage. `ignoredApps` records detected applications the
user deliberately left unselected, so later setup and MGD-003 runs do not ask about them again;
selecting an app clears its ignore. Snippet versions and hashes record
the exact selected content; a pinned snippet is kept at that revision. Each skill records its
source-local, kebab-case `id`, stable source provenance, source version, deterministic tree hash,
and pin state. Source provenance starts with `plugin:`, `directory:`, or `driver:`. A pinned skill
keeps its recorded revision. Each `mcpServers` entry records one desired server, the applications
that should receive it, and whether it belongs in global or project configuration. `catalogId`
records provenance for a catalog selection and is omitted for a custom server.

`overrides.requiredMcpServers` records an explicit decision to omit a server required by the active
preset. Setup requires interactive confirmation before adding this override, clears it when the
server is selected or the preset no longer requires it, and reports the deviation through MCP-001
without trying to converge the omitted server. Both new lists accept at most 256 unique, valid IDs.
They and `overrides` are optional; no schema-version bump is required.

Unknown keys inside `overrides` are preserved so a manifest written by a newer Aura survives a
downgrade, bounded at 32 camelCase names — setup rebuilds this object on every run, so the
forward-compatibility window is deliberately not general-purpose storage.

`trustedRepoPresets` records repository presets the user accepted during interactive setup: the
preset's absolute path and a SHA-256 hash of its canonicalized contents. Only acceptances are
recorded — declining leaves no entry, so the next interactive setup asks again — and an entry
whose hash no longer matches the file treats the preset as untrusted until the new contents are
reviewed. The list holds at most 64 entries; recording a new acceptance past that drops the
oldest. The field is optional and needs no schema-version bump.

Aura installs each managed skill once below `~/agents/skills/<id>` and links supported application
skill directories to that shared copy. Two sources may publish the same local ID, but a manifest
cannot select both at once because they would share the same installation directory.

A driver source is recorded as `driver:<namespaced-driver-id>`. If that driver is offline, fails,
or is disabled in the current distribution, setup preserves the existing entry and installed tree;
it never treats temporary source unavailability as a request to remove desired state.

## MCP credential safety

MCP definitions contain credential references, never credential values. Stdio `env` entries must
match `^[A-Z_][A-Z0-9_]*$`; an entry such as `TOKEN=value` makes the manifest read-only. A header
value must be `${VARIABLE}` references plus at most sixteen characters of letters and spaces, so
`Bearer ${SENTRY_TOKEN}` is accepted and a value carrying a plain-text secret alongside an unused
reference is not. Header names use the HTTP token grammar.

Server names contain only letters, digits, `.`, `_`, and `-`; consecutive dots and the reserved
object-property names `__proto__`, `prototype`, and `constructor` are rejected. One name may be
declared once per application per scope: a second entry claiming it for an application that already
has it makes the manifest read-only, because convergence would otherwise pick a winner by position.
Every entry names at least one application. Aura also refuses recognized credential literals in
commands, arguments, URLs, and headers. HTTP transports require an absolute HTTP(S) URL without
embedded username or password credentials.

A transport keeps fields this release does not define, so a manifest written by a later Aura
survives a round-trip through an earlier one. Those fields are held to the same bar: a field
belonging to the other transport kind is refused outright — `headers` on a `stdio` transport would
otherwise reach an application without ever passing the header rules — and everything else is
scanned for credential literals before it is kept. Each check runs on both manifest reads and
writes, so an unsafe definition is never propagated into application configuration.

## Skill directory tokens

The same rule covers remote skill directories: configuration names an environment variable, never
a value. A private directory — registered by a plugin or listed in the workspace team preset
(`.aura/preset.json`) — carries `tokenEnv` matching `^[A-Z_][A-Z0-9_]*$`. Aura reads the variable
only after an explicit per-run connection approval, sends it as a bearer header over TLS, and stores it nowhere: not in the manifest,
not in the installed skill tree, not in a diagnostic — a rejected token is reported by the
variable's name. A directory whose variable is unset simply lists as unavailable with the variable
to set. The manifest records only provenance for an installed directory skill: its source id,
version, and tree hash, written after the skill's full SKILL.md was reviewed on screen.

See the [team preset reference](./team-preset/) for the complete schema and directory protocol.

## Ownership ledger

Desired state and ownership are separate. The desired sections describe what should exist;
`ownership` records exactly what Aura wrote during the previous converge. When a selection changes,
Aura removes only entries present in that application's ledger, writes the new desired entries, and
leaves user-authored configuration alone.

The ledger must remain present while an application is disabled so the next converge can clean up
Aura-owned entries without guessing from names or counts.

## Compatibility and recovery

Aura validates known fields and reports failures with a JSON path such as
`$.ownership["custom.app"].files[0]`. Unknown fields are retained when a supported manifest is read
and written, allowing newer producers to add data without older releases discarding it — including
a field named `__proto__`, which is treated as ordinary data. Values may nest up to 100 levels.
Aura normalizes formatting to two-space JSON with one trailing newline; preservation applies to
JSON values and structure, not original whitespace.

An unsupported schema version, invalid JSON, invalid known field, or unreadable manifest puts Aura
in read-only mode. Checks still run, but no fix plan is applied: every operation is reported as
blocked in the preview, so a run says why up front rather than failing once you confirm it. Aura
never regenerates or overwrites the problematic file: repair it, restore it from a backup, or move
it aside after preserving a copy. A newer schema version means the installed Aura release must be
upgraded.

Manifest writes use the same preview, atomic replacement, backup, lock, and undo path as other Aura
fixes. The file mode is always enforced as `0o600`, because future desired-state entries may refer
to private sources. The manifest is the only file Aura holds at a fixed mode, and the fix-plan
kernel recognises it by path — no plan, from a plugin or otherwise, can ask for the same treatment
elsewhere. Every other existing file keeps the permissions it already has.
