import type { ShimResponse, TestSeed } from "../types.js";
import { createSeedBuilder } from "../seed.js";

export type CursorFixtureVersion = "3.11.0" | "4.0.0";
export type CursorRulesFixture = "current" | "legacy";

export interface CursorSeedOptions {
  readonly rules: CursorRulesFixture;
  readonly version: CursorFixtureVersion;
}

/** The `cursor` executable's answers, for composing multi-app seeds on one builder. */
export function cursorShimResponses(
  options: Pick<CursorSeedOptions, "version">,
): readonly ShimResponse[] {
  return [{ args: ["--version"], stdout: `${options.version}\nfixture-commit\narm64\n` }];
}

/** Builds documented Cursor rule and MCP configuration against an exact editor version. */
export function createCursorSeed(options: CursorSeedOptions): Promise<TestSeed> {
  let builder = createSeedBuilder()
    .homeFile(
      ".cursor/mcp.json",
      JSON.stringify(
        {
          mcpServers: {
            docs: {
              args: ["-y", "@example/docs-mcp"],
              command: "npx",
              env: { DOCS_TOKEN: "${env:DOCS_TOKEN}" },
            },
          },
        },
        undefined,
        2,
      ) + "\n",
    )
    .workspaceFile(
      ".cursor/mcp.json",
      JSON.stringify(
        {
          mcpServers: {
            sentry: {
              headers: { Authorization: "Bearer ${env:SENTRY_TOKEN}" },
              url: "https://mcp.sentry.dev/mcp?token=sk-fixture-secret",
            },
          },
        },
        undefined,
        2,
      ) + "\n",
    )
    .shim("cursor", cursorShimResponses(options));

  if (options.rules === "legacy") {
    builder = builder
      .workspaceFile(
        ".cursorrules",
        "# Legacy Cursor instructions\n\nUse the repository conventions.\n",
      )
      // A wrong-extension file proves the modern rule parser does not accidentally pick it up.
      .workspaceFile(".cursor/rules/ignored.md", "# Not a Cursor project rule\n");
  } else {
    builder = builder
      .workspaceFile("AGENTS.md", "# Project agents guide\n\nFollow the workspace conventions.\n")
      .workspaceFile(
        ".cursor/rules/project.mdc",
        "---\nalwaysApply: true\n---\n\nUse @project-template.ts.\n",
      )
      .workspaceFile(".cursor/rules/project-template.ts", "export const template = true;\n")
      .workspaceFile(
        ".cursor/rules/backend/database.mdc",
        "---\ndescription: Database conventions\nalwaysApply: false\n---\n\nRead @schema.sql.\n",
      )
      .workspaceFile(".cursor/rules/backend/schema.sql", "select 1;\n")
      .workspaceFile(".cursor/rules/ignored.md", "# Not a Cursor project rule\n");
  }

  return builder.build();
}
