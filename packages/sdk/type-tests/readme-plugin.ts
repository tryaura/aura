// This file is the example in README.md, compiled so the documentation cannot drift.
// Keep the two in sync.
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
  detectionScope: "the acme-agent CLI on PATH",
  displayName: "Acme Agent",
  files({ environment }) {
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
  mcpWrite: ({ existingContent }) => ({ content: existingContent ?? "{}\n" }),
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
  apiVersion: 2,
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
