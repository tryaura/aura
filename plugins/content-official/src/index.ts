import { definePlugin, pluginContentUrl, type FileContentSource } from "@tryaura/aura-sdk";

/** Neutral starter content used when Aura creates the canonical shared instruction source. */
export const SHARED_INSTRUCTIONS_TEMPLATE = "# Shared agent instructions\n";

const contentSource = (path: string): FileContentSource => ({
  type: "file",
  url: pluginContentUrl(import.meta.url, path),
});

export default definePlugin({
  apiVersion: 1,
  // Deliberately not the package's "content-official": the plugin id namespaces every
  // user-facing snippet id, and "official/commit-conventions" is the intended spelling.
  id: "official",
  name: "Aura Official Content",
  mcpCatalog: [
    {
      description: "Connect Atlassian Rovo to Jira and Confluence through Atlassian OAuth.",
      id: "official/atlassian-rovo",
      kind: "mcp-server",
      name: "Atlassian Rovo",
      source: contentSource("mcp/atlassian-rovo.json"),
      version: "1.0.0",
    },
    {
      description: "Connect GitHub repositories, issues, and pull requests with a personal token.",
      id: "official/github",
      kind: "mcp-server",
      name: "GitHub",
      source: contentSource("mcp/github.json"),
      version: "1.0.0",
    },
    {
      description: "Connect Sentry projects, issues, and telemetry with an auth token.",
      id: "official/sentry",
      kind: "mcp-server",
      name: "Sentry",
      source: contentSource("mcp/sentry.json"),
      version: "1.0.0",
    },
  ],
  skillDirectories: [
    {
      id: "directory:agenticskills",
      kind: "directory",
      name: "agenticskills.io",
      protocol: "agenticskills",
      url: "https://agenticskills.io",
    },
  ],
  snippets: [
    {
      category: "git",
      description: "Apply clear, consistent conventions to Git commits.",
      id: "official/commit-conventions",
      kind: "snippet",
      name: "Commit conventions",
      source: contentSource("snippets/commit-conventions.md"),
      version: "1.0.0",
    },
    {
      category: "safety",
      description: "Require confirmation before destructive or irreversible operations.",
      id: "official/ask-before-destructive",
      kind: "snippet",
      name: "Ask before destructive operations",
      source: contentSource("snippets/ask-before-destructive.md"),
      version: "1.0.0",
    },
    {
      category: "git",
      description: "Write pull request descriptions that explain intent and validation.",
      id: "official/pr-descriptions",
      kind: "snippet",
      name: "Pull request descriptions",
      source: contentSource("snippets/pr-descriptions.md"),
      version: "1.0.0",
    },
    {
      category: "atlassian",
      description: "Keep Jira issue references consistent across development artifacts.",
      id: "official/jira-linking",
      kind: "snippet",
      name: "Jira issue linking",
      source: contentSource("snippets/jira-linking.md"),
      version: "1.0.0",
    },
    {
      category: "atlassian",
      description: "Reference Confluence without hiding execution-critical context.",
      id: "official/confluence-references",
      kind: "snippet",
      name: "Confluence references",
      source: contentSource("snippets/confluence-references.md"),
      version: "1.0.0",
    },
    {
      category: "language",
      description: "Apply strict and explicit TypeScript typing conventions.",
      id: "official/typescript-style",
      kind: "snippet",
      name: "TypeScript style",
      source: contentSource("snippets/typescript-style.md"),
      version: "1.0.0",
    },
    {
      category: "language",
      description: "Apply typed Python conventions with consistent Ruff validation.",
      id: "official/python-style",
      kind: "snippet",
      name: "Python style",
      source: contentSource("snippets/python-style.md"),
      version: "1.0.0",
    },
  ],
  version: "0.0.0",
});
