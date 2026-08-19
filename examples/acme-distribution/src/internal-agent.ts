import { join } from "node:path";

import {
  defineAdapter,
  detectExecutable,
  jsonMcpEntry,
  parseInstalledSkills,
  parseJsonMcpConfig,
  skillDirectorySpecs,
  writeJsonMcpServers,
  type AdapterParseInput,
  type AdapterProblem,
  type AdapterSourceFile,
  type AdapterSkillDirectory,
  type InstructionDocument,
  type McpWrite,
  type ParsedJsonMcpConfig,
} from "@tryaura/aura-sdk";

export const ACME_AGENT_ID = "acme-agent";
const INSTRUCTIONS_ID = "acme-agent.instructions.global";
const MCP_ID = "acme-agent.mcp.global";
const SKILL_DIRECTORIES = [
  { entryPath: "~/.acme-agent/skills", id: "acme-agent.skills.global" },
] satisfies readonly AdapterSkillDirectory[];

const writeMcpServers: McpWrite = (input) =>
  writeJsonMcpServers(input, (entry) => jsonMcpEntry(entry, (name) => `\${${name}}`));

function instructionFiles(file: AdapterSourceFile | undefined): readonly InstructionDocument[] {
  if (file?.content === undefined) {
    return [];
  }

  return [
    {
      content: file.content,
      links: [],
      path: file.spec.path,
      scope: file.spec.scope,
      sourceId: file.spec.id,
    },
  ];
}

function parseMcp(file: AdapterSourceFile | undefined): ParsedJsonMcpConfig {
  if (file === undefined) {
    return { malformed: false, servers: [], unusable: [] };
  }

  return parseJsonMcpConfig(file, {
    appId: ACME_AGENT_ID,
    variablePattern: /\$\{([A-Z_][A-Z0-9_]*)\}/gu,
  });
}

function mcpProblems(
  file: AdapterSourceFile | undefined,
  mcp: ParsedJsonMcpConfig,
): readonly AdapterProblem[] {
  if (!mcp.malformed || file === undefined) {
    return [];
  }

  return [
    {
      message: `Acme Agent's MCP configuration at ${file.spec.path} is not valid JSON.`,
      sourceId: MCP_ID,
    },
  ];
}

function parseAcmeAgent(input: AdapterParseInput) {
  const mcpFile = input.files.get(MCP_ID);
  const mcp = parseMcp(mcpFile);

  return {
    instructionFiles: instructionFiles(input.files.get(INSTRUCTIONS_ID)),
    mcpServers: mcp.servers,
    problems: mcpProblems(mcpFile, mcp),
    skills: parseInstalledSkills(ACME_AGENT_ID, input, SKILL_DIRECTORIES),
    unusableMcpServers: mcp.unusable,
  };
}

export const acmeAgentAdapter = defineAdapter({
  capabilities: {
    instructions: { importStyle: "none", loading: "all-files" },
    skills: { directories: SKILL_DIRECTORIES },
  },
  detect: (environment) => detectExecutable(environment, { binaryName: "acme-agent" }),
  detectionScope: "the acme-agent CLI on PATH",
  displayName: "Acme Agent",
  files(input) {
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
  id: ACME_AGENT_ID,
  installHint: "Install acme-agent from the Acme engineering portal.",
  mcpWrite: writeMcpServers,
  parse: parseAcmeAgent,
  sharedLink: { entryPath: "~/.acme-agent/AGENTS.md", kind: "symlink" },
  supportedRange: ">=1 <2",
});
