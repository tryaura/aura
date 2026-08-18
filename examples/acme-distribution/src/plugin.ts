import {
  defineCheck,
  definePlugin,
  pluginContentUrl,
  type WorkspaceModel,
} from "@tryaura/aura-sdk";

import { ACME_AGENT_ID, acmeAgentAdapter } from "./internal-agent.js";

function contentUrl(path: string): string {
  return pluginContentUrl(import.meta.url, path);
}

const distributionCheck = defineCheck({
  defaultSeverity: "error",
  detect(model) {
    const missing = missingContributions(model);
    return [
      {
        id: missing.length === 0 ? "configured" : "missing",
        message:
          missing.length === 0
            ? "The Acme distribution loaded its agent, snippet, skill, and MCP definition."
            : `The Acme distribution is missing: ${missing.join(", ")}.`,
      },
    ];
  },
  explain: "Proves the example distribution and every private contribution loaded.",
  fixability: "manual",
  id: "acme/ACME-001",
  scope: "global",
  title: "Acme distribution loads",
});

function missingContributions(model: WorkspaceModel): readonly string[] {
  const contributions: readonly (readonly [loaded: boolean, name: string])[] = [
    [model.apps.some((app) => app.adapterId === ACME_AGENT_ID), "agent"],
    [model.availableSnippets.some((snippet) => snippet.id === "acme/engineering"), "snippet"],
    [
      model.availableSkills?.some(
        (skill) => skill.source.id === "plugin:acme" && skill.id === "acme-release",
      ) === true,
      "skill",
    ],
    [
      model.availableMcpServers.some((server) => server.id === "acme/source-control"),
      "MCP definition",
    ],
  ];

  return contributions.flatMap(([loaded, name]) => (loaded ? [] : [name]));
}

export default definePlugin({
  adapters: [acmeAgentAdapter],
  apiVersion: 1,
  checks: [distributionCheck],
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
