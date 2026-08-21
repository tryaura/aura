---
title: Share content from a repository
description: Commit snippets, Agent Skills, and MCP server definitions that Aura offers to everyone working in a repository.
---

Repository-provided content keeps project-specific agent guidance beside the code it governs. Use
it when a snippet, skill, or MCP server belongs to one repository and should not require a custom
Aura distribution or plugin.

After you commit the files, each teammate runs `aura setup`. Aura shows the repository-controlled
settings, asks the teammate to trust them, and then offers each entity through the normal setup
picker. Trusting the repository does not install its content by itself: snippets require a tick,
skills require a separate review decision, and MCP servers require a configuration selection.

:::caution[Repository content can affect agent behavior]
Review repository-provided instructions and executable MCP transports with the same care as code.
Aura shows this content before trusting or installing it, never accepts first use under
`aura setup --yes`, and stores no credential values in the repository preset.
:::

## Create the repository layout

Add a `.aura` directory at the repository root:

```text
.aura/
├── preset.json
├── snippets/
│   └── commit-guidance.md
└── skills/
    └── release-runbook/
        ├── SKILL.md
        └── checklist.md
```

Only `.aura/preset.json` is required. Add the content directories you need, then commit the entire
`.aura` tree.

## Add a repository snippet

Create `.aura/snippets/commit-guidance.md`:

```md
---
name: Commit guidance
description: Repository-specific commit instructions.
---

Use conventional commits and keep each commit focused.
```

The filename stem must be kebab-case. Aura derives the ID `repo/commit-guidance` from the file and
uses the Markdown after the optional frontmatter as the snippet body.

Add the ID to `.aura/preset.json` when you want the picker to label it as selected by the
repository:

```json
{
  "schemaVersion": 1,
  "name": "Acme repository",
  "snippets": ["repo/commit-guidance"]
}
```

Repository snippets always open unticked, including when `snippets` lists their ID. A teammate
must preview and select a snippet before Aura appends it to `~/agents/AGENTS.md`. After installation,
the manifest records the snippet as install history; changing the repository file does not rewrite
text already installed on a teammate's machine.

## Add a repository skill

Create `.aura/skills/release-runbook/SKILL.md`:

```md
---
name: release-runbook
description: Prepare and verify a release from this repository.
version: 1.0.0
---

# Release runbook

1. Run the verification suite.
2. Review the release diff.
3. Follow the checklist in `checklist.md`.
```

Keep the directory and skill `name` kebab-case so the installed skill passes Aura's validation.
Use a canonical semantic version such as `1.0.0` so revision labels remain meaningful. Place
supporting Markdown or reference files below the same skill directory; Aura reviews and copies the
complete tree.

Select the skill in `.aura/preset.json` with the repository source ID:

```json
{
  "schemaVersion": 1,
  "skills": [{ "id": "release-runbook", "source": "repo:workspace" }]
}
```

The skill appears under **This repository**. The selection can open ticked, but the following
Review screen defaults to **Skip**. A teammate must inspect and approve the skill before Aura
copies it to `~/agents/skills/release-runbook` and links it into supported managed applications.
Aura requires another interactive review whenever the skill tree changes.

### Keep other skill sources visible

`allowedSkillSources` is an exhaustive allowlist when present. This configuration shows only the
repository source and hides every registered directory or plugin source:

```json
{
  "allowedSkillSources": ["repo:workspace"]
}
```

Omit the field to keep every registered source available. To allow repository skills and Aura's
default `agenticskills.io` directory while excluding other sources, list both IDs:

```json
{
  "allowedSkillSources": ["repo:workspace", "directory:agenticskills"]
}
```

## Add an MCP server

Repository MCP definitions live inline in `.aura/preset.json`, so the trust prompt can show the
exact command or endpoint the repository wants applications to use:

```json
{
  "schemaVersion": 1,
  "provides": {
    "mcpServers": [
      {
        "schemaVersion": 1,
        "id": "repo/docs",
        "name": "Repository docs",
        "serverName": "repo-docs",
        "description": "Search this repository's internal documentation.",
        "docsUrl": "https://engineering.acme.example/repo-docs-mcp",
        "credentialEnv": [],
        "supportedApps": ["codex"],
        "transportTemplate": {
          "type": "stdio",
          "command": "repo-docs-mcp"
        }
      }
    ]
  }
}
```

Every ID must begin with `repo/`. `serverName` is the name written into application configuration.
Use `supportedApps` to limit the applications offered by the picker, or omit it when every managed
application may use the server.

To make the server mandatory policy for this repository, also list it in
`requiredMcpServers`:

```json
{
  "requiredMcpServers": ["repo/docs"]
}
```

A required server opens selected and is labelled **from repo, required**. Aura asks the user to
confirm its name and applications, then installs it into each selected application's global MCP
configuration. The repository definition is trusted input; Aura does not write repository files.

Credential fields declare environment variable names, never values. See the
[MCP catalog reference](/docs/reference/mcp-catalog/) for HTTP transports, headers, and
`credentialEnv` entries.

## Complete example

This preset selects one entity of each kind and keeps Aura's default skill directory visible:

```json
{
  "schemaVersion": 1,
  "name": "Acme repository",
  "snippets": ["repo/commit-guidance"],
  "skills": [{ "id": "release-runbook", "source": "repo:workspace" }],
  "allowedSkillSources": ["repo:workspace", "directory:agenticskills"],
  "requiredMcpServers": ["repo/docs"],
  "provides": {
    "mcpServers": [
      {
        "schemaVersion": 1,
        "id": "repo/docs",
        "name": "Repository docs",
        "serverName": "repo-docs",
        "description": "Search this repository's internal documentation.",
        "docsUrl": "https://engineering.acme.example/repo-docs-mcp",
        "credentialEnv": [],
        "supportedApps": ["codex"],
        "transportTemplate": {
          "type": "stdio",
          "command": "repo-docs-mcp"
        }
      }
    ]
  }
}
```

## Review and apply the content

From the repository root, run:

```sh
aura setup
```

On first use, verify that the trust screen names every selected entity and shows the inline MCP
transport. After accepting trust:

1. Preview and tick the repository snippet.
2. Select the repository skill, preview its `SKILL.md`, and choose **Install**.
3. Confirm the MCP server's name and target applications.
4. Review the final file plan and choose **Apply**.

Then verify the resulting application state:

```sh
aura check
```

Run `aura setup` again to review later repository changes. Unattended setup does not establish
trust, first-install repository content, or approve a changed skill revision.

## Understand what changes require review

| Repository change                         | What the next run does                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------ |
| Edit `.aura/preset.json`                  | Asks the user to trust the new preset contents.                                      |
| Add or edit a snippet                     | Asks for repository trust again because snippet bytes participate in the trust hash. |
| Add or edit a skill tree                  | Keeps repository trust, but requires a separate interactive skill review.            |
| Change an inline MCP definition           | Asks for repository trust again because the definition lives in the preset.          |
| Run `aura setup --yes` before first trust | Holds all repository-provided content and tells the user to run interactive setup.   |

Trust applies to the repository, including linked worktrees that share its primary checkout. Aura
records accepted preset hashes in `~/agents/aura.json`; it never modifies the committed
`.aura` files during setup.

## Troubleshooting

### Only repository skills appear

Check `allowedSkillSources`. If it contains only `repo:workspace`, the preset is deliberately
hiding every other source. Remove the field or add the IDs that teammates should see, such as
`directory:agenticskills`.

### A repository skill does not appear

Confirm that its directory name is kebab-case, contains a readable `SKILL.md`, stays inside
`.aura/skills`, and fits within Aura's content limits. Aura reports a note and drops an invalid
skill tree instead of blocking unrelated setup choices.

### Setup rejects the snippets directory

Snippet filenames must be kebab-case Markdown files directly below `.aura/snippets`. Aura fails
closed for unreadable, oversized, symlinked, or badly named snippet files because their contents
participate in the repository trust decision.

### A required MCP server blocks the plan

Read the blocker for the unavailable application or scope. Confirm that `supportedApps` names an
installed managed application and select a configuration scope that its adapter can write. Use
interactive `aura setup` for a server's first configuration; `aura setup --yes` never performs that
approval.

For the complete schema, precedence rules, limits, and non-interactive behavior, see the
[team preset reference](/docs/reference/team-preset/).
