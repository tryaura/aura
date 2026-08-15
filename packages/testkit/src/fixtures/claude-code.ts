import type { TestSeed } from "../types.js";
import { createSeedBuilder } from "../seed.js";

/** One version inside the adapter's supported range and one past its ceiling. */
export type ClaudeCodeFixtureVersion = "2.1.233" | "3.0.0";

export interface ClaudeCodeSeedOptions {
  readonly authenticated: boolean;
  readonly version: ClaudeCodeFixtureVersion;
}

/** Builds one documented Claude Code global configuration against an exact CLI version. */
export function createClaudeCodeSeed(options: ClaudeCodeSeedOptions): Promise<TestSeed> {
  return createSeedBuilder()
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
    .homeFile(
      ".claude.json",
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
          },
        },
        undefined,
        2,
      ) + "\n",
    )
    .homeFile("agents/AGENTS.md", "# Shared agent instructions\n")
    .shim("claude", [
      { args: ["--version"], stdout: `${options.version} (Claude Code)\n` },
      {
        args: ["auth", "status"],
        exitCode: options.authenticated ? 0 : 1,
        stdout: JSON.stringify({ loggedIn: options.authenticated }) + "\n",
      },
    ])
    .build();
}
