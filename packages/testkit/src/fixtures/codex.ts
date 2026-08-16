import type { ShimResponse, TestSeed } from "../types.js";
import { createSeedBuilder } from "../seed.js";

/** Verified versions plus the first version outside the adapter's supported range. */
export type CodexFixtureVersion = "0.146.0" | "0.147.0" | "0.148.0";

/**
 * Which project instruction files the workspace ships.
 *
 * `"root"` seeds the repository-root `AGENTS.md` alone. `"nested"` adds a Git marker and a second
 * `AGENTS.md` inside {@link CODEX_NESTED_PACKAGE}, so a scan invoked from that package walks the
 * same two levels Codex does. `"override"` adds the root `AGENTS.override.md` that Codex prefers
 * over the `AGENTS.md` beside it.
 */
export type CodexProjectInstructions = "nested" | "override" | "root";

/** Workspace-relative directory the `"nested"` layout puts its second `AGENTS.md` in. */
export const CODEX_NESTED_PACKAGE = "packages/app";

export interface CodexSeedOptions {
  readonly authenticated: boolean;
  /** Project instruction layout. Omitted means the workspace ships none. */
  readonly projectInstructions?: CodexProjectInstructions | undefined;
  /** Record the workspace under `[projects]` in `config.toml`; omitted means no entry at all. */
  readonly projectTrust?: "trusted" | "untrusted" | undefined;
  readonly version: CodexFixtureVersion;
}

/** The `codex` executable's answers, for composing multi-app seeds on one builder. */
export function codexShimResponses(
  options: Pick<CodexSeedOptions, "authenticated" | "version">,
): readonly ShimResponse[] {
  return [
    { args: ["--version"], stdout: `codex-cli ${options.version}\n` },
    {
      args: ["login", "status"],
      exitCode: options.authenticated ? 0 : 1,
      stdout: options.authenticated ? "Logged in using ChatGPT\n" : "Not logged in\n",
    },
  ];
}

/** Builds one documented Codex configuration against an exact CLI version. */
export function createCodexSeed(options: CodexSeedOptions): Promise<TestSeed> {
  let builder = createSeedBuilder()
    .homeFile(
      ".codex/AGENTS.md",
      ["# Global Codex instructions", "", "Follow the shared Aura instructions.", ""].join("\n"),
    )
    .homeFile(".codex/config.toml", ({ workspaceDir }) =>
      codexConfiguration(workspaceDir, options.projectTrust),
    )
    .homeFile("agents/AGENTS.md", "# Shared agent instructions\n")
    .shim("codex", codexShimResponses(options));

  if (options.projectInstructions !== undefined) {
    builder = builder.workspaceFile("AGENTS.md", instructions("Project"));
  }
  if (options.projectInstructions === "override") {
    builder = builder.workspaceFile("AGENTS.override.md", instructions("Project override"));
  }
  if (options.projectInstructions === "nested") {
    builder = builder
      // A worktree leaves a `.git` file rather than a directory, and project-root detection accepts
      // either, so the cheaper one is what the fixture writes.
      .workspaceFile(".git", "gitdir: /dev/null\n")
      .workspaceFile(`${CODEX_NESTED_PACKAGE}/AGENTS.md`, instructions("Package"));
  }

  return builder.build();
}

function instructions(title: string): string {
  return [
    `# ${title} Codex instructions`,
    "",
    `Prefer the ${title.toLowerCase()} conventions.`,
    "",
  ].join("\n");
}

function codexConfiguration(
  workspaceDir: string,
  trust: "trusted" | "untrusted" | undefined,
): string {
  return [
    'model = "gpt-5"',
    "",
    ...(trust === undefined
      ? []
      : [`[projects.${JSON.stringify(workspaceDir)}]`, `trust_level = "${trust}"`, ""]),
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
  ].join("\n");
}
