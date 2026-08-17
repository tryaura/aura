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
  "apps": {
    "claude-code": { "managed": true }
  },
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
  "mcpServers": [],
  "ownership": {
    "claude-code": {
      "mcpServerNames": [],
      "files": ["~/.claude/CLAUDE.md#aura-block"]
    }
  }
}
```

`apps` records which detected applications Aura should manage. Snippet versions and hashes record
the exact selected content; a pinned snippet is kept at that revision. Each skill records its
source-local, kebab-case `id`, stable source provenance, source version, deterministic tree hash,
and pin state. Source provenance starts with `plugin:`, `directory:`, or `driver:`. A pinned skill
keeps its recorded revision. `mcpServers` is populated by its corresponding setup feature.

Aura installs each managed skill once below `~/agents/skills/<id>` and links supported application
skill directories to that shared copy. Two sources may publish the same local ID, but a manifest
cannot select both at once because they would share the same installation directory.

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
