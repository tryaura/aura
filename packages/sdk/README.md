# `@tryaura/aura-sdk`

The public plugin API for Aura distributions. This is the only Aura package a plugin author
needs. It has no runtime dependencies, and `apiVersion` is the compatibility gate for plugin
loading.

Plugin authors need `@types/node` on their `tsconfig` for the `import.meta.url` idiom used to
reference bundled content.

## Plugin contributions

Create plugins with `definePlugin`. A plugin declares an `id`, a `name`, a `version`, and
`apiVersion: 1`. Every contribution slot is optional:

- `adapters` detect an agent application, declare the files core should read, and parse those
  supplied contents into a normalized snapshot.
- `checks` synchronously inspect the normalized `WorkspaceModel` and may return a `FixPlan`.
- `snippets` reference Markdown files.
- `skills` reference skill directories.
- `skillSources` are build-time drivers that list and resolve external skills.
- `mcpCatalog` references JSON MCP catalog entries.
- `presets` references JSON preset definitions.

Aura v1 accepts only plugins with `apiVersion: 1`. The registry validates the version, IDs,
collisions, and referenced content before use. Every contribution `id` must be namespaced under
the plugin's own `id`, so plugin `acme` contributes `acme/rules`.

## Trust model

**A plugin runs with the full privileges of the Aura process.** `Adapter.detect` and the
`SkillSource` methods receive an `Environment` and can execute commands. Install plugins with the
same care you apply to any other dependency; Aura does not sandbox them.

The declarative shapes in this SDK exist for _previewability_, not isolation. Checks are pure so a
single scan can evaluate every rule reproducibly. Fixes return data so Aura can show a diff, dry
run, back up, and undo. Neither is a security boundary.

What the SDK does enforce:

- `ExecRequest` separates `command` from `args`, and Aura core never spawns a shell, so argument
  values are not word-split or glob-expanded. Never build a single `command` string by
  interpolation.
- The child process environment is supplied by core, not the plugin, so a plugin cannot inject
  `NODE_OPTIONS` or `LD_PRELOAD` into a child.
- `exec` is always time-bounded: `timeoutMs` defaults to `DEFAULT_EXEC_TIMEOUT_MS` and is clamped
  to `MAX_EXEC_TIMEOUT_MS`, so one hung command cannot stall a scan.
- `FixPlan.operations` is a closed union of write, remove, move, and symlink — a fix cannot run a
  command or make a network request. `WriteFileOperation.mode` accepts only `0o600`, `0o644`,
  `0o700`, and `0o755`, and core rechecks the value at runtime rather than trusting the type, so a
  plan cannot request world-writable or setuid files even from untyped JavaScript. An existing file
  keeps the mode it already has; a plan has no way to override that. Core enforces an exact mode on
  the few files it owns as protocol — currently only `~/agents/aura.json`, which stays at `0o600` —
  and it selects those by path, so a plan cannot nominate a file for that treatment.
- Every path in a plan, including a symlink `target`, must resolve inside the workspace or the
  Aura-managed part of the home directory. Core rejects plans that escape those roots.

Two things need care from the plugin author:

- Every `metadata` field is `JsonObject` and is rendered into reports, logs, and CI output. Never
  put credentials or raw file contents in one. Note how `StdioMcpTransport.environmentVariables`
  and `HttpMcpTransport.headerEnvironmentVariables` carry variable _names_ and never values —
  follow that pattern.
- `WorkspaceModel` spans every application, so a check sees instruction file contents and MCP
  configuration contributed by adapters from other plugins. Do not copy `InstructionDocument`
  content into a finding.

## Example plugin

This example is compiled as a type test in `type-tests/readme-plugin.ts`.

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
  async detect(environment) {
    const result = await environment.exec({
      args: ["--version"],
      command: "acme-agent",
      timeoutMs: 5_000,
    });

    return {
      installed: result.exitCode === 0,
      version: result.stdout.trim(),
    };
  },
  displayName: "Acme Agent",
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
  id: "acme-agent",
  parse({ files }) {
    const instructions = files.get("acme.instructions.global");

    if (!instructions?.content) {
      return { instructionFiles: [], mcpServers: [], skills: [] };
    }

    return {
      instructionFiles: [
        {
          content: instructions.content,
          links: [],
          path: instructions.spec.path,
          scope: instructions.spec.scope,
          sourceId: instructions.spec.id,
        },
      ],
      mcpServers: [],
      skills: [],
    };
  },
  supportedRange: ">=1 <2",
});

const check = defineCheck({
  defaultSeverity: "warn",
  detect(model) {
    if (model.instructionFiles.length > 0) {
      return [];
    }

    return [
      {
        id: "acme/INS-001:global",
        message: "The shared instruction file is missing.",
      },
    ];
  },
  explain: "Shared instructions keep behavior consistent across agent applications.",
  fix(_finding, model) {
    return {
      operations: [
        {
          content: "# Shared instructions\n",
          path: `${model.homeDir}/agents/AGENTS.md`,
          type: "write",
        },
      ],
      summary: "Create the shared instruction file.",
    };
  },
  fixability: "auto",
  id: "acme/INS-001",
  scope: "global",
  title: "Shared instructions exist",
});

export default definePlugin({
  adapters: [adapter],
  apiVersion: 1,
  checks: [check],
  id: "acme",
  name: "Acme",
  snippets: [
    {
      description: "Acme's shared coding rules.",
      id: "acme/rules",
      kind: "snippet",
      name: "Acme rules",
      source: rules,
      version: "1.0.0",
    },
  ],
  version: "1.0.0",
});
```

## Environment and model invariants

`Environment` contains injected HOME, cwd, PATH entries, platform, command execution, and clock.
Adapters may use it during asynchronous detection and file discovery. They return file specs;
Aura core performs the reads and supplies `AdapterSourceFile` values to the synchronous `parse`
method. `AdapterParseInput.projectRoot` identifies the repository containing cwd when one was
found. Parsing must not read the filesystem.

`ExecRequest.command` is resolved against `Environment.pathEntries` when it is a bare name, which
a hijacked `PATH` can subvert. Record the resolved path as `AdapterDetection.executablePath` and
pass that absolute path as `command` on later calls.

Checks are synchronous and pure. They receive a `WorkspaceModel` containing app state, instruction
documents, MCP servers, installed skills, source-file metadata, the `~/agents/aura.json` manifest
state, and an optional repository snapshot. `model.manifest` distinguishes a missing manifest from
a parsed v1 manifest and a read-only problem. Checks never read from disk or inspect process
environment directly.

`RepositoryModel` carries the root `.gitignore` and the repository-local `info/exclude`, so a rule
a developer applied only to their own checkout is not mistaken for a missing one.
`trackedAgentPaths` lists tracked paths that agent applications are known to write, not the whole
checkout: a large repository holds hundreds of thousands of paths, and retaining them all for the
lifetime of a scan costs far more than any check can use.
`packageManifests` carries only tracked `package.json` paths, declared package names, and script
names. Raw manifest contents and script commands are not retained, the set is bounded by path
order rather than growing with the repository, and the field is absent when Git cannot enumerate
the repository. A name is trimmed but not validated against npm's rules, so a check that builds a
pattern from one must escape it.

A check that reads another plugin's contribution — a metadata key, or a source id used to locate a
file — should import that name from the contributing package rather than retype it as a literal.
A literal keeps compiling after a rename and silently stops matching, which turns into a check that
quietly reports nothing.

A check emits `DetectedFinding` values carrying only what is specific to the occurrence — `id`,
`message`, and optionally `details`, `locations`, `metadata`, and a `severity` override. Aura core
stamps on `checkId`, `scope`, and the resolved `severity` from the owning check, so a finding
cannot contradict the check that produced it.

`AppModel.sourceFiles` reports only whether each declared path existed. Contents are consumed by
`parse` and are not retained alongside the documents parsed out of them, so a large instruction
file is held once rather than twice. `Adapter.installHint` becomes `AppModel.installHint`, allowing
checks to give application-specific update guidance without guessing how an adapter was installed.

`SkillSource.resolve` takes every requested id at once and returns a `ReadonlyMap`, so resolving a
listing costs one round trip instead of one per skill. Ids that cannot be resolved are omitted
rather than throwing.

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

`Snippet`, `SkillPack`, `McpServerDef`, and `Preset` share the `ContentContribution` fields and are
distinguished by a `kind` discriminant, so a snippet cannot be passed where a preset is expected.
