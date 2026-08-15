# `@tryaura/aura-sdk`

The public plugin API for Aura distributions. This is the only Aura package a plugin author
needs. It has no runtime dependencies, and `apiVersion` is the compatibility gate for plugin
loading.

## Plugin contributions

Create plugins with `definePlugin`. Every contribution slot is optional:

- `adapters` detect an agent application, declare the files core should read, and parse those
  supplied contents into a normalized snapshot.
- `checks` synchronously inspect the normalized `WorkspaceModel` and may return a `FixPlan`.
- `snippets` reference Markdown files.
- `skills` reference skill directories.
- `skillSources` are build-time drivers that list and resolve external skills.
- `mcpCatalog` references JSON MCP catalog entries.
- `presets` references JSON preset definitions.

Aura v1 accepts only plugins with `apiVersion: 1`. The registry validates the version, IDs,
collisions, and referenced content before use.

## Example plugin

```ts
import {
  defineAdapter,
  defineCheck,
  definePlugin,
  type FileContentSource,
} from "@tryaura/aura-sdk";

const rules: FileContentSource = {
  type: "file",
  url: new URL("./content/rules.md", import.meta.url).href,
};

const adapter = defineAdapter({
  id: "acme-agent",
  displayName: "Acme Agent",
  supportedRange: ">=1 <2",
  async detect(environment) {
    const result = await environment.exec({
      command: "acme-agent",
      args: ["--version"],
    });

    return {
      installed: result.exitCode === 0,
      version: result.stdout.trim(),
    };
  },
  files(environment, detection) {
    if (!detection.installed) {
      return [];
    }

    return [
      {
        id: "acme.instructions.global",
        kind: "instructions",
        path: `${environment.homeDir}/.acme/INSTRUCTIONS.md`,
        scope: "global",
      },
    ];
  },
  parse({ files }) {
    const instructions = files[0];

    return {
      instructionFiles: instructions?.content
        ? [
            {
              content: instructions.content,
              links: [],
              path: instructions.spec.path,
              scope: instructions.spec.scope,
              sourceId: instructions.spec.id,
            },
          ]
        : [],
      mcpServers: [],
      skills: [],
    };
  },
});

const check = defineCheck({
  id: "acme/INS-001",
  title: "Shared instructions exist",
  explain: "Shared instructions keep behavior consistent across agent applications.",
  defaultSeverity: "warn",
  scope: "global",
  fixability: "auto",
  detect(model) {
    if (model.instructionFiles.length > 0) {
      return [];
    }

    return [
      {
        id: "acme/INS-001:global",
        checkId: "acme/INS-001",
        message: "The shared instruction file is missing.",
        scope: "global",
        severity: "warn",
      },
    ];
  },
  fix(_finding, model) {
    return {
      summary: "Create the shared instruction file.",
      operations: [
        {
          type: "write",
          path: `${model.homeDir}/agents/AGENTS.md`,
          content: "# Shared instructions\n",
        },
      ],
    };
  },
});

export default definePlugin({
  name: "acme",
  apiVersion: 1,
  adapters: [adapter],
  checks: [check],
  snippets: [
    {
      id: "acme/rules",
      name: "Acme rules",
      description: "Acme's shared coding rules.",
      version: "1.0.0",
      source: rules,
    },
  ],
});
```

## Environment and model invariants

`Environment` contains injected HOME, cwd, PATH entries, platform, command execution, and clock.
Adapters may use it during asynchronous detection and file discovery. They return file specs;
Aura core performs the reads and supplies `AdapterSourceFile` values to the synchronous `parse`
method. Parsing must not read the filesystem.

Checks are synchronous and pure. They receive a `WorkspaceModel` containing app state,
instruction documents, MCP servers, installed skills, and source-file metadata. Checks never read
from disk or inspect process environment directly.

Fixes return data only. `FixPlan.operations` is a closed union of write, remove, move, and symlink
operations. Aura core owns diff previews, dry runs, backups, execution, and undo.

## Content references

Content references must be absolute `file:` URLs. Construct portable references relative to the
plugin module:

```ts
const url = new URL("./content/preset.json", import.meta.url).href;
```

Do not use cwd-relative paths. Filesystem existence and content schema validation occur when the
plugin registry loads the contribution.
