import { join } from "node:path";

import {
  defineAdapter,
  defineCheck,
  definePlugin,
  DEFAULT_EXEC_TIMEOUT_MS,
  type DirectoryContentSource,
  type FileContentSource,
  type McpServerDef,
  type Preset,
  type SkillPack,
  type SkillSourceDriver,
  type Snippet,
} from "@tryaura/aura-sdk";

const snippetSource: FileContentSource = {
  type: "file",
  url: "file:///example-plugin/content/rules.md",
};

const directorySource: DirectoryContentSource = {
  type: "directory",
  url: "file:///example-plugin/content/example-skill/",
};

const snippet: Snippet = {
  category: "example",
  description: "Adds the sample project's coding rules.",
  id: "example/rules",
  kind: "snippet",
  name: "Example rules",
  source: snippetSource,
  version: "1.0.0",
};

const skill: SkillPack = {
  description: "Demonstrates a bundled skill.",
  id: "example/review",
  kind: "skill-pack",
  name: "Example review",
  source: directorySource,
  version: "1.0.0",
};

const mcpServer: McpServerDef = {
  description: "Demonstrates an MCP catalog entry.",
  id: "example/server",
  kind: "mcp-server",
  name: "Example server",
  source: {
    type: "file",
    url: "file:///example-plugin/content/mcp.json",
  },
  version: "1.0.0",
};

const preset: Preset = {
  description: "Selects all example contributions.",
  id: "example/default",
  kind: "preset",
  name: "Example default",
  source: {
    type: "file",
    url: "file:///example-plugin/content/preset.json",
  },
  version: "1.0.0",
};

const skillSource: SkillSourceDriver = {
  description: "Resolves skills from an example source.",
  id: "example/source",
  async list(environment) {
    await environment.exec({ command: "example-skills", args: ["list"] });
    return [
      {
        description: skill.description,
        id: skill.id,
        name: skill.name,
        version: skill.version,
      },
    ];
  },
  name: "Example source",
  async resolve(environment, skillIds) {
    await environment.exec({ args: ["get", ...skillIds], command: "example-skills" });
    return new Map(skillIds.filter((id) => id === skill.id).map((id) => [id, skill]));
  },
};

const adapter = defineAdapter({
  async detect(environment) {
    const result = await environment.exec({
      args: ["--version"],
      command: "example-agent",
      cwd: environment.cwd,
      timeoutMs: DEFAULT_EXEC_TIMEOUT_MS,
    });

    return {
      authenticated: result.exitCode === 0,
      executablePath: `${environment.pathEntries[0] ?? ""}/example-agent`,
      installed: result.exitCode === 0,
      version: result.stdout.trim(),
    };
  },
  displayName: "Example Agent",
  files({ detection, environment }) {
    if (!detection.installed) {
      return [];
    }

    return [
      {
        id: "example.instructions.global",
        kind: "instructions",
        optional: true,
        path: `${environment.homeDir}/.example/INSTRUCTIONS.md`,
        scope: "global",
      },
      {
        id: "example.mcp.project",
        kind: "mcp",
        optional: true,
        path: `${environment.cwd}/.example-mcp.json`,
        scope: "project",
      },
      {
        id: "example.skills.global",
        kind: "skills",
        optional: true,
        path: `${environment.homeDir}/.example/skills`,
        scope: "global",
      },
    ];
  },
  id: "example-agent",
  parse(input) {
    const instructions = input.files.get("example.instructions.global");

    return {
      instructionFiles: instructions?.content
        ? [
            {
              content: instructions.content,
              links: [
                {
                  kind: "import",
                  targetPath: join(input.homeDir, "agents", "AGENTS.md"),
                  valid: true,
                },
              ],
              path: instructions.spec.path,
              scope: instructions.spec.scope,
              sourceId: instructions.spec.id,
            },
          ]
        : [],
      mcpServers: [
        {
          appId: "example-agent",
          name: "example",
          scope: "project",
          sourceId: "example.mcp.project",
          transport: {
            args: ["serve"],
            command: "example-mcp",
            environmentVariables: ["EXAMPLE_TOKEN"],
            type: "stdio",
          },
        },
      ],
      skills: [
        {
          appId: "example-agent",
          id: skill.id,
          invocationName: "example-review",
          name: skill.name,
          path: "/tmp/example-review",
          scope: "global",
          sourceId: skillSource.id,
          version: skill.version,
        },
      ],
    };
  },
  supportedRange: ">=1.0.0 <2.0.0",
});

const check = defineCheck({
  defaultSeverity: "warn",
  detect(model) {
    if (model.instructionFiles.length > 0) {
      return [];
    }

    return [
      {
        id: "example/INS-001:global",
        locations: [{ path: `${model.homeDir}/agents/AGENTS.md` }],
        message: "The shared instruction file is missing.",
        metadata: { expectedPath: `${model.homeDir}/agents/AGENTS.md` },
        severity: "error",
      },
    ];
  },
  explain: "A shared instruction file keeps agent behavior consistent across applications.",
  fix(finding, model) {
    const sharedPath = `${model.homeDir}/agents/AGENTS.md`;

    if (finding.checkId !== "example/INS-001") {
      return undefined;
    }

    return {
      manualSteps: [`Review ${finding.message}`],
      operations: [
        { content: "# Shared instructions\n", mode: 0o644, path: sharedPath, type: "write" },
        { path: `${sharedPath}.old`, type: "remove" },
        {
          destinationPath: `${sharedPath}.archive`,
          sourcePath: `${sharedPath}.legacy`,
          type: "move",
        },
        { path: `${model.cwd}/AGENTS.md`, target: sharedPath, type: "symlink" },
      ],
      summary: "Create and link the shared instruction file.",
    };
  },
  fixability: "guided",
  id: "example/INS-001",
  scope: "global",
  title: "Shared instructions exist",
});

export const samplePlugin = definePlugin({
  adapters: [adapter],
  apiVersion: 1,
  checks: [check],
  id: "example",
  mcpCatalog: [mcpServer],
  name: "Example",
  presets: [preset],
  skills: [skill],
  skillSources: [skillSource],
  snippets: [snippet],
  version: "1.0.0",
});

// Optional properties accept an explicitly computed `undefined` under
// `exactOptionalPropertyTypes`, so adapters need no conditional spreads.
function optionalVersion(output: string): string | undefined {
  return output === "" ? undefined : output;
}

export const detectionWithComputedOptional = defineAdapter({
  async detect(environment) {
    const result = await environment.exec({ command: "example-agent" });

    return {
      installed: result.exitCode === 0,
      metadata: undefined,
      version: optionalVersion(result.stdout.trim()),
    };
  },
  displayName: "Optional Example",
  files: () => [],
  id: "optional-example",
  parse: () => ({ instructionFiles: [], mcpServers: [], skills: [] }),
  supportedRange: ">=1",
});
