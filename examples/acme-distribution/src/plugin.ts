import {
  defineCheck,
  definePlugin,
  pluginContentUrl,
  type DriverSkillPack,
  type WorkspaceModel,
} from "@tryaura/aura-sdk";

import { ACME_AGENT_ID, acmeAgentAdapter } from "./internal-agent.js";

function contentUrl(path: string): string {
  return pluginContentUrl(import.meta.url, path);
}

const driverReviewSkill: DriverSkillPack = {
  description: "Review an Acme change before it lands.",
  id: "acme-review",
  kind: "skill-pack",
  name: "Acme review",
  originUrl: "https://engineering.acme.example/skills/acme-review",
  source: { type: "directory", url: contentUrl("skills/acme-review/") },
  version: "1.0.0",
};

const distributionCheck = defineCheck({
  defaultSeverity: "error",
  detect(model) {
    const missing = missingContributions(model);
    return [
      {
        id: missing.length === 0 ? "configured" : "missing",
        message:
          missing.length === 0
            ? "The Acme distribution loaded its agent, skill, and MCP definition."
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
  apiVersion: 2,
  checks: [distributionCheck],
  disabledSkillSources: ["directory:agenticskills"],
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
  presets: [
    {
      description: "Acme's default runtime checks, content, and skill policy.",
      id: "acme/platform",
      kind: "preset",
      name: "Acme platform",
      source: { type: "file", url: contentUrl("presets/platform.json") },
      version: "1.0.0",
    },
  ],
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
  skillSources: [
    {
      description: "Skills published by Acme engineering.",
      id: "acme/engineering-skills",
      async list() {
        const { source: _source, kind: _kind, ...listing } = driverReviewSkill;
        return [listing];
      },
      name: "Acme engineering skills",
      async resolve(_environment, skillIds) {
        return new Map(
          skillIds.flatMap((id) => (id === driverReviewSkill.id ? [[id, driverReviewSkill]] : [])),
        );
      },
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
