import {
  defineAdapter,
  defineCheck,
  definePlugin,
  type DirectoryContentSource,
  type Environment,
  type FileContentSource,
  type FixPlan,
  type McpServerDef,
  type Preset,
  type SkillPack,
  type SkillSource,
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
  description: "Adds the sample project's coding rules.",
  id: "example/rules",
  name: "Example rules",
  source: snippetSource,
  version: "1.0.0",
};

const skill: SkillPack = {
  description: "Demonstrates a bundled skill.",
  id: "example/review",
  name: "Example review",
  source: directorySource,
  version: "1.0.0",
};

const mcpServer: McpServerDef = {
  description: "Demonstrates an MCP catalog entry.",
  id: "example/server",
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
  name: "Example default",
  source: {
    type: "file",
    url: "file:///example-plugin/content/preset.json",
  },
  version: "1.0.0",
};

const skillSource: SkillSource = {
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
  async resolve(environment, skillId) {
    await environment.exec({ command: "example-skills", args: ["get", skillId] });
    return skillId === skill.id ? skill : undefined;
  },
};

const adapter = defineAdapter({
  async detect(environment: Environment) {
    const result = await environment.exec({
      command: "example-agent",
      args: ["--version"],
      cwd: environment.cwd,
      timeoutMs: 1_000,
    });

    return {
      authenticated: result.exitCode === 0,
      installed: result.exitCode === 0,
      version: result.stdout.trim(),
    };
  },
  displayName: "Example Agent",
  files(environment, detection) {
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
    const instructions = input.files.find((file) => file.spec.kind === "instructions");

    return {
      instructionFiles: instructions?.content
        ? [
            {
              content: instructions.content,
              links: [
                {
                  kind: "import",
                  targetPath: "~/agents/AGENTS.md",
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
        checkId: "example/INS-001",
        id: "example/INS-001:global",
        locations: [{ path: `${model.homeDir}/agents/AGENTS.md` }],
        message: "The shared instruction file is missing.",
        metadata: { expectedPath: `${model.homeDir}/agents/AGENTS.md` },
        scope: "global",
        severity: "warn",
      },
    ];
  },
  explain: "A shared instruction file keeps agent behavior consistent across applications.",
  fix(finding, model) {
    const sharedPath = `${model.homeDir}/agents/AGENTS.md`;

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
  fixability: "auto",
  id: "example/INS-001",
  scope: "global",
  title: "Shared instructions exist",
});

export const samplePlugin = definePlugin({
  adapters: [adapter],
  apiVersion: 1,
  checks: [check],
  mcpCatalog: [mcpServer],
  name: "example",
  presets: [preset],
  skills: [skill],
  skillSources: [skillSource],
  snippets: [snippet],
});

definePlugin({
  // @ts-expect-error API v1 plugins must use the literal version 1.
  apiVersion: 2,
  name: "invalid-version",
});

defineCheck({
  defaultSeverity: "warn",
  // @ts-expect-error Check detection must return complete Finding values.
  detect: () => [{ message: "Missing finding identity and scope." }],
  explain: "Invalid check shape.",
  fixability: "manual",
  id: "example/INVALID",
  scope: "global",
  title: "Invalid check",
});

const invalidSnippet: Snippet = {
  description: "Invalid source shape.",
  id: "example/invalid",
  name: "Invalid snippet",
  // @ts-expect-error Snippets must reference a file, not a directory.
  source: directorySource,
  version: "1.0.0",
};

const invalidFixPlan: FixPlan = {
  operations: [
    {
      // @ts-expect-error Fix plans accept only the closed file-operation union.
      type: "execute",
    },
  ],
  summary: "Invalid fix",
};

void invalidSnippet;
void invalidFixPlan;
