import type { ShimResponse, TestSeed } from "../types.js";
import { createSeedBuilder } from "../seed.js";

/** One version inside the adapter's supported range and one past its ceiling. */
export type ClaudeCodeFixtureVersion = "2.1.233" | "3.0.0";

export interface ClaudeCodeSeedOptions {
  readonly authenticated: boolean;
  readonly version: ClaudeCodeFixtureVersion;
}

/** The `claude` executable's answers, for composing multi-app seeds on one builder. */
export function claudeCodeShimResponses(options: ClaudeCodeSeedOptions): readonly ShimResponse[] {
  return [
    { args: ["--version"], stdout: `${options.version} (Claude Code)\n` },
    {
      args: ["auth", "status"],
      exitCode: options.authenticated ? 0 : 1,
      stdout: JSON.stringify({ loggedIn: options.authenticated }) + "\n",
    },
  ];
}

/** Builds documented Claude Code global and project configuration against an exact CLI version. */
export function createClaudeCodeSeed(options: ClaudeCodeSeedOptions): Promise<TestSeed> {
  return (
    createSeedBuilder()
      .homeFile(
        ".claude/CLAUDE.md",
        [
          "# Global Claude Code instructions",
          "",
          "@~/agents/AGENTS.md",
          "See @team.md for team-specific details.",
          "Ask @alice about @tryaura/core; neither is an import.",
          "Keep `@literal.md` as an example.",
          "```md",
          "@fenced.md",
          "```",
          "",
        ].join("\n"),
      )
      .homeFile(".claude/team.md", "# Team instructions\n")
      .homeFile(".claude/settings.json", '{"permissions":{"allow":["Bash(pnpm test)"]}}\n')
      .homeFile("agents/AGENTS.md", "# Shared agent instructions\n")
      // Keyed by the workspace path, the way Claude Code records a `claude mcp add -s local` server.
      .homeFile(".claude.json", ({ workspaceDir }) => claudeConfiguration(workspaceDir))
      .workspaceFile(
        "CLAUDE.md",
        [
          "# Project Claude Code instructions",
          "",
          "@./docs/project.md",
          "@~/agents/AGENTS.md",
          "",
        ].join("\n"),
      )
      .workspaceFile("docs/project.md", "# Project-specific instructions\n")
      .workspaceFile(
        ".mcp.json",
        JSON.stringify(
          {
            mcpServers: {
              projectDocs: {
                args: ["--project"],
                command: "project-docs-server",
                env: { PROJECT_TOKEN: "${PROJECT_TOKEN}" },
              },
            },
          },
          undefined,
          2,
        ) + "\n",
      )
      .shim("claude", claudeCodeShimResponses(options))
      // MCP-003 resolves configured commands on PATH without executing them.
      .shim("npx", [{ args: [] }])
      .shim("project-docs-server", [{ args: [] }])
      .build()
  );
}

function claudeConfiguration(workspaceDir: string): string {
  return (
    JSON.stringify(
      {
        mcpServers: {
          docs: {
            args: ["-y", "@example/docs-mcp"],
            command: "npx",
            env: { DOCS_TOKEN: "${DOCS_TOKEN}" },
          },
          // Configured the way a user who pasted a token on the command line would have it.
          legacy: {
            args: ["@example/legacy-mcp", "--api-key", "sk-fixture-secret"],
            command: "npx",
          },
          sentry: {
            headers: { Authorization: "Bearer ${SENTRY_TOKEN}" },
            type: "http",
            url: "https://mcp.sentry.dev",
          },
          streaming: { type: "sse", url: "https://sse.example.com/mcp?token=sk-fixture-secret" },
        },
        projects: {
          "/unrelated/project": {
            mcpServers: { ignored: { command: "ignored" } },
          },
          [workspaceDir]: {
            mcpServers: {
              local: {
                headers: { Authorization: "Bearer ${LOCAL_TOKEN}" },
                type: "http",
                url: "https://local.example.com/mcp?token=sk-local-secret",
              },
            },
          },
        },
      },
      undefined,
      2,
    ) + "\n"
  );
}
