import type { TestSeed } from "../types.js";
import { createSeedBuilder } from "../seed.js";

/** Verified versions plus the first version outside the adapter's supported range. */
export type CodexFixtureVersion = "0.146.0" | "0.147.0" | "0.148.0";

export interface CodexSeedOptions {
  readonly authenticated: boolean;
  readonly version: CodexFixtureVersion;
}

/** Builds one documented Codex global configuration against an exact CLI version. */
export function createCodexSeed(options: CodexSeedOptions): Promise<TestSeed> {
  return createSeedBuilder()
    .homeFile(
      ".codex/AGENTS.md",
      ["# Global Codex instructions", "", "Follow the shared Aura instructions.", ""].join("\n"),
    )
    .homeFile(
      ".codex/config.toml",
      [
        'model = "gpt-5"',
        "",
        "[mcp_servers.docs]",
        'command = "npx"',
        'args = ["-y", "@example/docs-mcp"]',
        'env = { DOCS_TOKEN = "inline-fixture-secret" }',
        'env_vars = ["LOCAL_TOKEN", { name = "REMOTE_TOKEN", source = "remote" }]',
        "",
        "[mcp_servers.legacy]",
        'command = "npx"',
        'args = ["@example/legacy-mcp", "--api-key", "sk-fixture-secret"]',
        "",
        "[mcp_servers.sentry]",
        'url = "https://mcp.sentry.dev/mcp?token=sk-fixture-secret"',
        'bearer_token_env_var = "SENTRY_TOKEN"',
        'http_headers = { "X-Static" = "inline-fixture-secret" }',
        'env_http_headers = { Authorization = "AUTH_TOKEN" }',
        "",
        "[mcp_servers.disabled]",
        'command = "ignored"',
        "enabled = false",
        "",
      ].join("\n"),
    )
    .homeFile("agents/AGENTS.md", "# Shared agent instructions\n")
    .shim("codex", [
      { args: ["--version"], stdout: `codex-cli ${options.version}\n` },
      {
        args: ["login", "status"],
        exitCode: options.authenticated ? 0 : 1,
        stdout: options.authenticated ? "Logged in using ChatGPT\n" : "Not logged in\n",
      },
    ])
    .build();
}
