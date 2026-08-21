---
title: Build an internal distribution
description: Create a branded Aura executable with private agent adapters, snippets, skills, and MCP catalog entries.
---

This walkthrough builds `acmedev`, an internal Aura distribution with one trusted plugin. The
plugin teaches Aura about an internal agent application and bundles a company-owned instruction
snippet, skill, and MCP server definition.

The repository includes the complete, CI-compiled project at
[`examples/acme-distribution`](https://github.com/tryaura/aura/tree/main/examples/acme-distribution).

Start with the package and local-tarball setup from
[Author a distribution](/docs/guides/distributions/). The examples below assume this project
layout:

```text
acmedev/
├── content/
│   ├── mcp/source-control.json
│   ├── skills/acme-review/SKILL.md
│   ├── skills/acme-release/SKILL.md
│   ├── skills/acme-release/references/checklist.md
│   └── snippets/engineering.md
├── src/
│   ├── internal-agent.ts
│   ├── plugin.ts
│   └── main.boundary.ts
└── build.mjs
```

:::caution[Only load trusted plugins]
Plugins run with the full privileges of the distribution process. Review private plugin code and
pin it like any other production dependency. Aura's declarative APIs make changes previewable;
they are not a sandbox.
:::

## 1. Model the internal agent

Aura calls applications such as Claude Code, Codex, and an in-house CLI _agents_. A plugin teaches
Aura about a new agent through an adapter. Skip this step when the internal tool already uses an
application and configuration format covered by an official adapter; adapter IDs are global, so a
distribution cannot register two adapters for the same application.

This example models an `acme-agent` executable that:

- reads `~/.acme-agent/AGENTS.md` for instructions;
- reads and writes a top-level `mcpServers` object in `~/.acme-agent/mcp.json`; and
- discovers Agent Skills below `~/.acme-agent/skills`.

Create `src/internal-agent.ts`:

```ts
import { join } from "node:path";

import {
  defineAdapter,
  detectExecutable,
  jsonMcpEntry,
  parseInstalledSkills,
  parseJsonMcpConfig,
  skillDirectorySpecs,
  writeJsonMcpServers,
  type AdapterSkillDirectory,
  type McpWrite,
} from "@tryaura/aura-sdk";

const ADAPTER_ID = "acme-agent";
const INSTRUCTIONS_ID = "acme-agent.instructions.global";
const MCP_ID = "acme-agent.mcp.global";
const SKILL_DIRECTORIES = [
  { entryPath: "~/.acme-agent/skills", id: "acme-agent.skills.global" },
] satisfies readonly AdapterSkillDirectory[];

const writeMcpServers: McpWrite = (input) =>
  writeJsonMcpServers(input, (entry) => jsonMcpEntry(entry, (name) => `\${${name}}`));

export const acmeAgentAdapter = defineAdapter({
  capabilities: {
    instructions: { importStyle: "none", loading: "all-files" },
    skills: { directories: SKILL_DIRECTORIES },
  },
  detect: (environment) => detectExecutable(environment, { binaryName: "acme-agent" }),
  detectionScope: "the acme-agent CLI on PATH",
  displayName: "Acme Agent",
  files(input) {
    if (!input.detection.installed) {
      return [];
    }

    return [
      {
        id: INSTRUCTIONS_ID,
        kind: "instructions",
        optional: true,
        path: join(input.environment.homeDir, ".acme-agent", "AGENTS.md"),
        scope: "global",
      },
      {
        id: MCP_ID,
        kind: "mcp",
        optional: true,
        path: join(input.environment.homeDir, ".acme-agent", "mcp.json"),
        scope: "global",
      },
      ...skillDirectorySpecs(input, SKILL_DIRECTORIES),
    ];
  },
  id: ADAPTER_ID,
  installHint: "Install acme-agent from the Acme engineering portal.",
  mcpWrite: writeMcpServers,
  parse(input) {
    const instructions = input.files.get(INSTRUCTIONS_ID);
    const mcpFile = input.files.get(MCP_ID);
    const mcp =
      mcpFile === undefined
        ? { malformed: false, servers: [], unusable: [] }
        : parseJsonMcpConfig(mcpFile, {
            appId: ADAPTER_ID,
            variablePattern: /\$\{([A-Z_][A-Z0-9_]*)\}/gu,
          });

    return {
      instructionFiles:
        instructions?.content === undefined
          ? []
          : [
              {
                content: instructions.content,
                links: [],
                path: instructions.spec.path,
                scope: instructions.spec.scope,
                sourceId: instructions.spec.id,
              },
            ],
      mcpServers: mcp.servers,
      problems:
        mcp.malformed && mcpFile !== undefined
          ? [
              {
                message: `Acme Agent's MCP configuration at ${mcpFile.spec.path} is not valid JSON.`,
                sourceId: MCP_ID,
              },
            ]
          : [],
      skills: parseInstalledSkills(ADAPTER_ID, input, SKILL_DIRECTORIES),
      unusableMcpServers: mcp.unusable,
    };
  },
  sharedLink: { entryPath: "~/.acme-agent/AGENTS.md", kind: "symlink" },
  supportedRange: ">=1 <2",
});
```

Keep detection read-only. `files` declares absolute paths, Aura core reads them, and `parse` stays
synchronous and pure. If the real agent uses another configuration shape, replace both the parser
and `mcpWrite`; a read implementation without a matching safe writer can inspect MCP state but
cannot converge it.

## 2. Add an instruction snippet

Snippets are Markdown fragments users can select during `acmedev setup`. Create
`content/snippets/engineering.md`:

```md
## Acme engineering

- Use the service owner listed in `service.yaml` for operational decisions.
- Link pull requests to an ACME issue.
- Run the repository's typecheck, test, and lint commands before requesting review.
```

Keep snippets short and imperative. Do not add frontmatter: Aura appends the plain Markdown once to
`~/agents/AGENTS.md`. Later runs show it as installed but never update or remove its text.

## 3. Add a skill

Skills are directories whose root contains `SKILL.md`. Create
`content/skills/acme-release/SKILL.md`:

```md
---
name: acme-release
description: Prepare and validate an Acme service release.
metadata:
  version: 1.0.0
---

# Acme release

1. Read `service.yaml` and identify the owner and deployment target.
2. Run the repository's release checks.
3. Summarize the version, rollout plan, and rollback plan.
4. Stop before publishing or deploying unless the user explicitly asks for it.
```

The contribution's skill ID is source-local and kebab-case. Aura installs the selected tree once
at `~/agents/skills/acme-release` and links it into every managed agent that declares compatible
skill directories.

A skill is a whole directory, so auxiliary files go beside `SKILL.md` and travel with it — the
example adds `references/checklist.md`. Aura resolves the tree recursively, in a compiled binary
as well as from source.

### Add a non-standard skill source

Use `skillSources` when an internal registry needs code to list or fetch skills. Driver IDs are
namespaced and become `driver:acme/engineering-skills` in presets and manifests. `list` supplies
metadata and a credential-free origin URL; `resolve` receives all selected IDs together and returns
packs pointing at local directories the driver materialized:

```ts
const review = {
  description: "Review an Acme change before it lands.",
  id: "acme-review",
  kind: "skill-pack" as const,
  name: "Acme review",
  originUrl: "https://engineering.acme.example/skills/acme-review",
  source: { type: "directory" as const, url: contentUrl("skills/acme-review/") },
  version: "1.0.0",
};

const engineeringSkills = {
  description: "Skills published by Acme engineering.",
  id: "acme/engineering-skills",
  async list() {
    const { kind, source, ...listing } = review;
    return [listing];
  },
  name: "Acme engineering skills",
  async resolve(_environment, ids: readonly string[]) {
    return new Map(ids.flatMap((id) => (id === review.id ? [[id, review]] : [])));
  },
};
```

Aura calls drivers only from interactive Skills setup, caches each listing for the run, safely
reads returned directories, and shows the source, origin, version, and `SKILL.md` before install.
Never put environment values, command output, file contents, or caught errors in driver metadata.
Add `skillSources: [engineeringSkills]` to the plugin and allow
`driver:acme/engineering-skills` in the team preset.

An internal plugin can remove optional distribution defaults with an exact denylist:

```ts
disabledSkillSources: ["directory:agenticskills"];
```

Missing targets are ignored. Existing manifest selections are preserved as unavailable rather than
being silently removed.

## 4. Add an MCP catalog entry

Create `content/mcp/source-control.json`. The payload describes a credential-safe transport; it
never contains the credential itself:

```json
{
  "schemaVersion": 1,
  "id": "acme/source-control",
  "name": "Acme source control",
  "serverName": "acme-source-control",
  "description": "Search Acme repositories, pull requests, and code owners.",
  "docsUrl": "https://engineering.acme.example/mcp/source-control",
  "supportedApps": ["acme-agent", "claude-code", "codex", "cursor"],
  "credentialEnv": [
    {
      "name": "ACME_SOURCE_TOKEN",
      "description": "Authenticates to Acme source control.",
      "setupUrl": "https://engineering.acme.example/tokens"
    }
  ],
  "transportTemplate": {
    "type": "http",
    "url": "https://mcp.acme.example/source-control",
    "headers": {
      "Authorization": "Bearer ${ACME_SOURCE_TOKEN}"
    }
  }
}
```

Every catalog document must include `docsUrl` and `credentialEnv`. A server that needs no
credentials still declares `"credentialEnv": []`. See the
[MCP catalog reference](/docs/reference/mcp-catalog/) for the complete field and transport rules.

The `credentialEnv` list declares every variable referenced by the transport. Stdio definitions
use `env: ["VARIABLE_NAME"]`; HTTP headers use `${VARIABLE_NAME}` templates. Never put a token in
the command, arguments, URL, headers, plugin metadata, or binary.

:::note[Current MCP setup boundary]
This release resolves registered MCP definitions and can converge entries already selected in
`~/agents/aura.json`, but the setup wizard does not yet provide an MCP picker. Until it does, an
internal bootstrap must add the desired `mcpServers` manifest entry, including `catalogId`, the
transport, target app IDs, and scope. Follow the
[desired-state manifest reference](/docs/reference/manifest/) and preserve every existing manifest
section and ownership entry.
:::

## 5. Register the plugin

Create `src/plugin.ts`. Every snippet and MCP ID is namespaced under `acme`; bundled skill
IDs are the exception and remain source-local.

```ts
import { definePlugin, pluginContentUrl } from "@tryaura/aura-sdk";

import { acmeAgentAdapter } from "./internal-agent.js";

function contentUrl(path: string): string {
  return pluginContentUrl(import.meta.url, path);
}

export default definePlugin({
  adapters: [acmeAgentAdapter],
  apiVersion: 2,
  id: "acme",
  mcpCatalog: [
    {
      description: "Search Acme repositories, pull requests, and code owners.",
      id: "acme/source-control",
      kind: "mcp-server",
      name: "Acme source control",
      source: { type: "file", url: contentUrl("mcp/source-control.json") },
      version: "1.0.0",
    },
  ],
  name: "Acme internal configuration",
  skills: [
    {
      description: "Prepare and validate an Acme service release.",
      id: "acme-release",
      kind: "skill-pack",
      name: "Acme release",
      source: { type: "directory", url: contentUrl("skills/acme-release/") },
      version: "1.0.0",
    },
  ],
  snippets: [
    {
      category: "acme",
      description: "Apply Acme's shared engineering conventions.",
      id: "acme/engineering",
      kind: "snippet",
      name: "Acme engineering",
      source: { type: "file", url: contentUrl("snippets/engineering.md") },
      version: "1.0.0",
    },
  ],
  version: "1.0.0",
});
```

The source URLs must be absolute `file:` URLs relative to the plugin module. `pluginContentUrl`
builds them, resolving `content/` beside `src/` during development and beside the plugin module
itself inside a compiled executable, where Bun flattens both onto one virtual root. Aura validates
that the referenced files exist and that their payloads are valid when it scans the workspace.

## 6. Compose the distribution

Create `src/main.boundary.ts` and append the private plugin to the official build-time plugin list:

```ts
#!/usr/bin/env node
import { runCli, type CliDistro } from "@tryaura/aura-cli";
import { OFFICIAL_PLUGINS, OFFICIAL_REGISTRY_OPTIONS } from "@tryaura/aura-cli/plugins";

import internalPlugin from "./plugin.js";

const distro: CliDistro = {
  branding: {
    command: "acmedev",
    description: "Acme's agent configuration doctor",
    displayName: "Acme Dev",
    docsUrl: "https://engineering.acme.example/acmedev",
    version: "0.1.0",
  },
  plugins: [...OFFICIAL_PLUGINS, internalPlugin],
  registry: OFFICIAL_REGISTRY_OPTIONS,
};

await runCli(distro);
```

The plugin list is fixed at build time. End users install the distribution; they do not discover
or install plugin packages at runtime.

## 7. Typecheck and exercise setup

Run the source distribution before compiling it:

```sh
pnpm exec tsc --noEmit
bun run src/main.boundary.ts --help
bun run src/main.boundary.ts setup --dry-run
bun run src/main.boundary.ts check --json
```

Put a semver-producing `acme-agent --version` executable on `PATH` to verify the adapter appears as
detected. In the setup wizard, confirm that `Acme engineering` appears under snippets and
`Acme release` appears under skills. A malformed or missing snippet source should produce a
disabled row, not silently disappear.

After installation, rerun setup and confirm the snippet row is disabled as installed.

For automated coverage, use `createSeedBuilder`, `runSetup`, `runCheck`, and `runBinaryCheck` from
`@tryaura/aura-testkit`. Assert the selected snippet in `~/agents/AGENTS.md`, the skill tree below
`~/agents/skills`, the internal app model, and the MCP definition in `availableMcpServers`.

## 8. Compile every content asset

Follow the staging instructions in
[Author a distribution](/docs/guides/distributions/#compile-with-bun) so the official snippet
assets are present under `content/`.

Bun embeds only the files named as build entrypoints, and it does not warn about the ones you left
out. A skill file missing from the command line does not fail the build; it produces an executable
whose skill tree is quietly missing that file. Derive the list from the directory instead of
maintaining it by hand. Create `build.mjs`:

```js
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const paths = await readdir(join(root, "content"), { recursive: true });
const assets = paths
  .filter((path) => path.endsWith(".md") || path.endsWith(".json"))
  .map((path) => `content/${path}`)
  .sort();

const result = spawnSync(
  "bun",
  [
    "build",
    "src/main.boundary.ts",
    ...assets,
    "--compile",
    "--asset-naming=[dir]/[name].[ext]",
    "--loader",
    ".md:file",
    "--loader",
    ".json:file",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    "--outfile",
    "dist/acmedev",
  ],
  { cwd: root, stdio: "inherit" },
);

process.exit(result.status ?? 1);
```

`--asset-naming=[dir]/[name].[ext]` preserves the `content/...` directory structure inside the
executable, which is the layout `pluginContentUrl` resolves against at runtime. Flattening it
strands every content source.

Finally, run `dist/acmedev --version`, the binary smoke suite, and the repository's full typecheck,
test, lint, and formatting checks. Publish the executable through the internal software channel;
keep private registry credentials in distribution CI only.
