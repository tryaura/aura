---
title: Team preset
description: The repository-owned .aura/preset.json schema for skill sources and policy.
---

The optional `.aura/preset.json` file defines the remote skill directories a repository uses and
the source allowlist enforced during setup. It travels with the repository; credentials never do.

```json
{
  "schemaVersion": 1,
  "allowedSkillSources": ["plugin:official", "directory:acme"],
  "skillDirectories": [
    {
      "id": "directory:community",
      "name": "Community Skills",
      "url": "https://skills.example.com/api"
    },
    {
      "id": "directory:acme",
      "name": "Acme Skills",
      "url": "https://skills.acme.example",
      "tokenEnv": "ACME_SKILLS_TOKEN"
    }
  ]
}
```

## Fields

- `schemaVersion` is required and must be `1`.
- `allowedSkillSources` is optional. When present, it is exhaustive: sources not listed are hidden
  and cannot be installed. It accepts up to 256 `plugin:`, `directory:`, or `driver:` source IDs.
- `skillDirectories` is optional and accepts up to 32 definitions. IDs use `directory:` followed by
  a kebab-case name of at most 64 characters. Names are human-readable picker labels.
- `url` must be an absolute HTTPS base URL without credentials, a query string, or a fragment.
  Literal loopback HTTP addresses are accepted for local development.
- `tokenEnv` makes a directory private. It names an uppercase environment variable; it never
  contains the token itself.

An invalid or unreadable preset fails the Skills step closed. Aura reports the exact JSON path to
repair and performs no skill-directory requests until the file is valid. A missing preset is the
ordinary default and does not impose an allowlist.

## Private-directory approval

Before reading a private directory's token, interactive setup shows its name, URL, and environment
variable and asks which private sources may be contacted during that run. Nothing is preselected.
`aura setup --yes` therefore never sends a private token or first-installs content from a private
directory. Approval is deliberately scoped to the current run so a different checkout cannot reuse
an earlier repository's decision.

Tokens are sent only as bearer headers over TLS. Aura refuses redirects and stores token values
nowhere: not in the preset, manifest, installed files, diagnostics, or logs.

## Directory protocol

Aura requests `index.json` below the configured base URL. It must be a JSON array of listings with
string `id`, `name`, `description`, and `version` fields. A selected skill is fetched from
`skills/<id>` and returns the same fields plus `files`, an array of `{ "path", "content" }` objects.
Every pack must contain a root `SKILL.md`.

Remote paths must be portable across supported operating systems: absolute paths, traversal,
control characters, Windows-reserved characters and device names, and case-equivalent duplicates
are refused. Responses, files, entry counts, request duration, and request concurrency are bounded.
