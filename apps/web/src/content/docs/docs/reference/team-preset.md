---
title: Team preset
description: Runtime team preset schema, references, loading, and layered resolution.
---

A team preset is a versioned JSON document that configures checks and shared content without
executing preset-supplied code. Aura resolves configuration once at boot in this order:

`distribution defaults → selected preset → repository preset → ~/agents/aura.json → command-line flags`

Later layers win for check activation, severity, and each check's complete threshold object.
Required MCP servers and skill directories are additive. Manifest skill selections replace preset
onboarding defaults; snippet install history suppresses defaults already installed. Every effective
value records the layer that supplied it.

Running `aura setup --preset <ref>` is an explicit onboarding request: Aura creates the manifest
when necessary and stores the exact reference in `preset`. On a fresh manifest, setup starts with
the preset's uninstalled snippets, skills, and required MCP servers selected and labels those rows
“from preset.” Unavailable rows remain visible with the reason and next action. Installed snippet
IDs remain ticked and are never re-applied unless the user clears their records; existing skill
selections remain authoritative on later runs, so deliberate adjustments are not reset to preset
defaults.

```json
{
  "schemaVersion": 1,
  "name": "Acme platform",
  "checks": {
    "enabled": ["INS-007"],
    "disabled": ["MCP-002"],
    "severity": { "INS-007": "error" },
    "thresholds": { "INS-007": { "approxTokens": 12000 } }
  },
  "requiredMcpServers": ["official/github"],
  "snippets": ["official/engineering"],
  "skills": [{ "id": "review", "source": "plugin:official" }],
  "allowedSkillSources": ["plugin:official", "directory:acme"],
  "skillDirectories": [
    {
      "id": "directory:acme",
      "name": "Acme Skills",
      "url": "https://skills.acme.example",
      "tokenEnv": "ACME_SKILLS_TOKEN"
    }
  ]
}
```

## Selecting and loading a preset

Aura chooses the first available reference in this order: `--preset`, the manifest's `preset`,
then the distribution's default preset. The repository's `.aura/preset.json` is never selected as
the team preset — it is its own configuration layer, described below. Supported reference forms
are:

- `plugin:<preset-id>` for JSON bundled by a registered plugin;
- `npm:<package>@<exact-version>` for `package/preset.json` from the public npm registry;
- an absolute `https://` JSON URL;
- `file:...`; or
- a plain absolute or current-working-directory-relative path.

HTTPS and npm reads have time and size limits. npm packages are downloaded and inspected as data:
Aura never installs or imports the package and never runs lifecycle scripts. Archive links,
traversal paths, duplicate preset entries, oversized entries, and missing `preset.json` are
rejected.

An npm tarball must be served from `registry.npmjs.org` and must match the `dist.integrity` digest
the registry published for that version — `dist.shasum` is accepted for older packages. A version
publishing neither digest is refused rather than trusted, because bytes that cannot be tied back
to the resolved version are exactly the ones worth refusing.

Remote results are cached atomically for 24 hours below `~/agents/.cache/presets`. After expiry,
a refresh failure fails closed instead of using stale data. `--no-cache` bypasses both cache reads
and writes.

Fetching a remote reference is network access, so `check` performs it only with `--online`; without
it, an `npm:` or `https:` preset resolves from cache and otherwise fails with a note naming the
flag. `setup` already contacts skill directories to build its pickers and always resolves remotely.

## Repository preset layer

A repository may commit `.aura/preset.json` beside the code it governs. It uses the same schema
as a team preset and applies as its own configuration layer above whichever preset is selected
and below the user's manifest, so a repo can tighten or extend team policy while the user's own
overrides still win.

Because the file arrives by cloning rather than by anything the user selected, it applies only
after a first-use trust decision. Interactive `aura setup` asks once per repository, and
acceptance — the preset's absolute path, the repository's primary Git checkout when the run is
inside a linked worktree, plus a hash of its exact contents — is recorded in `~/agents/aura.json`
under `trustedRepoPresets` immediately, before the wizard opens, so backing out of a later step
does not discard it. A file that changes after acceptance is untrusted again until the new contents
are reviewed; declining records nothing and the next interactive setup asks again. Trust binds to
the repository, so every linked worktree of one checkout shares a decision made for the same
contents. Non-interactive runs never accept: `check`
resolves without the layer and prints one configuration note naming `setup`, and `setup --yes`
holds the layer and says so in the plan summary. An unreadable or invalid repository preset fails
the run closed rather than silently widening whatever the file was written to lock down.

The setup summary shows effective preset check settings as read-only policy, under a heading that
names the preset once. It does not copy them into `manifest.checks`: only an explicit manifest or
command-line override belongs in that layer. Installed snippets are inert install history: preset
changes do not update or remove their text. Existing managed skills stay at their recorded revision
until an interactive review accepts the displayed one. Non-interactive setup never changes managed
skills, and the summary lists the skill changes it held back.

## Repository-provided content

The repository layer is the one preset origin that may _define_ content rather than only select
what installed plugins publish. Three shapes are read, all gated behind the same trust decision:

Follow [Share content from a repository](/docs/guides/repository-provided-content/) for a
copyable, end-to-end setup using all three entity types.

```
.aura/
  preset.json          # may add provides.mcpServers (inline definitions)
  snippets/<id>.md     # auto-discovered; optional frontmatter (name, description); body = rest
  skills/<id>/SKILL.md # auto-discovered skill trees
```

- **Snippets** are discovered from `.aura/snippets/*.md`. The file stem must be kebab-case and
  becomes the id `repo/<stem>`; optional YAML frontmatter supplies `name` and `description`. The
  trust hash covers the preset file _plus every snippet body_, so any snippet edit re-asks
  consent. Listing `"repo/<stem>"` in the preset's `snippets` array labels it `(from repo)`, but
  repository rows always open unticked: arbitrary agent instructions require an explicit
  interactive selection before their first install, and `--yes` never appends them. In the picker,
  repository snippets lead the offered rows under `From this repository`. A broken snippet set
  (unreadable, oversized, symlinked, or badly named file) fails the run closed. At most 64 snippets
  are read.
- **Skills** are discovered from `.aura/skills/<id>/` (kebab-case directory names, each with a
  `SKILL.md`; frontmatter supplies name, description, and version). They are offered as the
  skill source `repo:workspace`, named `This repository`, whose rows lead the installable rows in
  the picker. Skill trees sit _outside_ the trust hash: they are offers, and the per-skill Review
  form (default Skip) gates every first install and every content change — a `--yes` run only
  re-applies repository skills the manifest already records. The source participates in
  `allowedSkillSources` like any other; pre-select one with
  `{ "id": "<id>", "source": "repo:workspace" }` in `skills`. Installs copy the trusted
  snapshot's bytes into `~/agents/skills/<id>` and link apps to it as usual. Broken trees earn a
  note and drop out. At most 32 skills are read, under the same per-skill file and size bounds as
  fetched skills.
- **MCP servers** live inline in the preset under `provides.mcpServers`, as full catalog
  definitions (the `McpServerManifest` shape) whose ids must be namespaced `repo/<name>` — the
  `repo` namespace is reserved against plugins. Inline is deliberate: the command line or
  endpoint is covered by the preset file's own hash and is spelled out verbatim in the trust
  prompt. Provided servers sort ahead of the optional rows in the MCP picker with the provenance
  `Repository: .aura/preset.json`, propose `project` scope, and are never pre-checked on their
  own. A repository may require its own server by also listing `repo/<name>` in
  `requiredMcpServers`: interactively that pre-checks the row at the top; non-interactively it is
  a named blocker, never a silent install. At most 16 definitions are accepted.

Only the repository layer may carry `provides` — a downloaded or bundled preset presenting it
fails validation. Setup reads repository-defined content into one in-memory snapshot and reuses it
through consent, configuration, pickers, previews, and installs, so the bytes reviewed by a run are
the bytes it applies even if the working tree changes mid-run. Read-only commands skip skill-tree
discovery entirely.

What `--yes` does with a trusted repository, per entity:

| Entity                     | First install                    | Previously installed        |
| -------------------------- | -------------------------------- | --------------------------- |
| Repository snippet         | never (explicit tick required)   | locked record row           |
| Skill                      | never (Review defaults Skip)     | converges from the manifest |
| MCP server (provided only) | never                            | converges from the manifest |
| MCP server (repo-required) | blocker naming interactive setup | converges from the manifest |

A revision that is not newer — a rollback, or a pair of versions this build cannot order — is
offered for review too, labelled a switch rather than an update. Aura keeps the recorded revision
either way, so a revision that was never offered would be one you could never resolve. Plugins must
declare canonical semver versions for snippets and skills. Skill versions participate in revision
review; snippet versions remain contribution metadata and are not stored after installation.

## Fields

- `schemaVersion` is required and must be `1`. `name` is optional so existing repository presets
  remain valid.
- `checks.enabled` and `checks.disabled` contain check IDs. The same ID cannot appear in both.
- `checks.severity` maps check IDs to `info`, `warn`, or `error`.
- `checks.thresholds` maps a check ID to an inert JSON object. Only that check receives the object.
  A check validates its own thresholds, so an unrecognized key or an out-of-range value fails
  configuration resolution and names the layer that set it, rather than silently leaving the
  built-in behavior in place. INS-007 accepts `approxTokens`, a positive whole number of tokens.
- `requiredMcpServers` contains registered catalog IDs. Requirements are added to managed,
  supported applications at global scope; unknown IDs fail configuration resolution. A requirement
  whose server name is already configured in your manifest leaves your own entry untouched and
  reports that it was not applied — the manifest outranks the preset here as it does elsewhere.
  Setup requires confirmation before omitting one and stores the resulting exception in
  `overrides.requiredMcpServers` until the server is selected or the requirement disappears. Only a
  run that actually resolved the preset rewrites that list, so an offline run leaves a recorded
  exception alone rather than reading "could not fetch" as "no longer required".
- `snippets` contains snippet IDs used as install defaults. A default applies only while that ID is
  absent from the manifest. `skills` uses source-qualified `{ "id", "source" }` entries. Optional
  unavailable content remains visible so setup can explain the problem.
- `allowedSkillSources` is exhaustive when present. It accepts up to 256 `plugin:`, `directory:`,
  `driver:`, or `repo:` source IDs.
- Driver sources use `driver:<plugin-id>/<driver-id>`. Disallowed drivers are filtered before their
  listing method can run. Plugin-level `disabledSkillSources` is applied first, so the effective
  catalog is the intersection of registered sources, plugin denylisting, and this allowlist.
- `skillDirectories` accepts up to 32 definitions. IDs begin with `directory:`. URLs must be
  credential-free HTTPS endpoints; literal loopback HTTP is allowed for development. `tokenEnv`
  names the uppercase environment variable containing a private directory token, never the token.

Unknown fields are tolerated. Recognized fields are depth- and size-bounded, errors identify the
JSON path, and rejected values are not echoed. Prototype-shaped keys and script-looking strings
are inert JSON data.

## Command-line overrides

The check and setup commands accept repeatable `--enable <check>`, `--disable <check>`,
`--severity <check>=<info|warn|error>`, and `--threshold '<check>=<JSON object>'` options. CLI
activation wins last. On `check`, `--only` then intersects the enabled set; selecting a disabled
check reports how to enable it. `check --explain <id>` loads configuration without scanning agent
adapters and reports effective activation, severity, thresholds, preset, and provenance in human
or JSON output.

## Private-directory approval and protocol

Before reading a private directory's token, interactive setup shows its name, URL, and environment
variable and asks which sources may be contacted for that run. `setup --yes` never sends a private
token or first-installs private content. Tokens are sent only as bearer headers over TLS and are
never stored.

Aura requests `index.json` below a directory base URL. It returns listings with string `id`,
`name`, `description`, and `version` fields. `skills/<id>` returns those fields plus `files`, an
array of `{ "path", "content" }`; every pack must contain a root `SKILL.md`. Responses, files,
paths, counts, duration, and concurrency are bounded, and unsafe or non-portable paths are refused.
