import { join } from "node:path";

import {
  defineAdapter,
  defineCheck,
  definePlugin,
  SHARED_INSTRUCTIONS_TEMPLATE_TOKEN,
  type AdapterFileSpec,
  type AuraPlugin,
} from "@tryaura/aura-sdk";

export function consolidationPlugin(): AuraPlugin {
  const ids = ["instructions.claude", "instructions.cursor", "instructions.windsurf"];
  const adapter = defineAdapter({
    detect: () => Promise.resolve({ installed: true, version: "1.0.0" }),
    displayName: "Fixture Agent",
    files: ({ environment }) => [
      instructionSpec(ids[0] ?? "claude", join(environment.homeDir, ".claude", "CLAUDE.md")),
      instructionSpec(ids[1] ?? "cursor", join(environment.homeDir, ".cursorrules")),
      instructionSpec(ids[2] ?? "windsurf", join(environment.homeDir, ".windsurfrules")),
    ],
    id: "fixture-agent",
    parse: ({ files }) => ({
      instructionFiles: [...files.values()].flatMap((file) =>
        file.content === undefined
          ? []
          : [
              {
                content: file.content,
                links: [],
                path: file.spec.path,
                scope: file.spec.scope,
                sourceId: file.spec.id,
              },
            ],
      ),
      mcpServers: [],
      skills: [],
    }),
    sharedLink: {
      entryPath: "~/.claude/CLAUDE.md",
      kind: "import-line",
      lineTemplate: `@${SHARED_INSTRUCTIONS_TEMPLATE_TOKEN}`,
    },
    supportedRange: ">=1 <2",
  });
  const duplicates = defineCheck({
    defaultSeverity: "warn",
    detect: (model) => {
      const claude = model.instructionFiles.find((document) => document.sourceId === ids[0]);
      const cursor = model.instructionFiles.find((document) => document.sourceId === ids[1]);
      if (claude === undefined || cursor === undefined) {
        return [];
      }
      // Byte-identical files cluster whole-file, the way the real INS-003 reports them; otherwise
      // the fixture reports the one shared line its tests place at line 3 of both files.
      const wholeFile = claude.content === cursor.content;
      const lastLine = wholeFile ? claude.content.split(/\r?\n/u).length : 3;
      return [
        {
          id: "fixture-duplicate",
          message: "Duplicate fixture guidance.",
          metadata: {
            identical: true,
            matches: [{ kind: "exact", left: 0, right: 1, similarity: 100 }],
            members: [
              { endLine: lastLine, path: claude.path, startLine: wholeFile ? 1 : 3 },
              { endLine: lastLine, path: cursor.path, startLine: wholeFile ? 1 : 3 },
            ],
          },
        },
      ];
    },
    explain: "Fixture duplicate check.",
    fixability: "manual",
    id: "INS-003",
    scope: "global",
    title: "Fixture instructions are unique",
  });
  return definePlugin({
    adapters: [adapter],
    apiVersion: 1,
    checks: [duplicates],
    id: "checks-core",
    name: "Fixture Checks",
    version: "1.0.0",
  });
}

function instructionSpec(id: string, path: string): AdapterFileSpec {
  return { id, kind: "instructions", optional: true, path, scope: "global" };
}

export function projectConsolidationPlugin(): AuraPlugin {
  return definePlugin({
    adapters: [
      defineAdapter({
        detect: () => Promise.resolve({ installed: true, version: "1.0.0" }),
        displayName: "Project Claude",
        files: ({ environment }) => [
          {
            id: "project-claude",
            kind: "instructions",
            optional: true,
            path: join(environment.cwd, "CLAUDE.md"),
            scope: "project",
          },
        ],
        id: "project-claude",
        parse: ({ files }) => {
          const file = files.get("project-claude");
          return {
            instructionFiles:
              file?.content === undefined
                ? []
                : [
                    {
                      content: file.content,
                      links: [],
                      path: file.spec.path,
                      scope: file.spec.scope,
                      sourceId: file.spec.id,
                    },
                  ],
            mcpServers: [],
            skills: [],
          };
        },
        projectSharedLink: {
          entryPath: "./CLAUDE.md",
          kind: "import-line",
          lineTemplate: `@${SHARED_INSTRUCTIONS_TEMPLATE_TOKEN}`,
        },
        supportedRange: ">=1 <2",
      }),
    ],
    apiVersion: 1,
    id: "project-consolidation",
    name: "Project Consolidation",
    version: "1.0.0",
  });
}
