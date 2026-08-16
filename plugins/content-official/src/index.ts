import { definePlugin, type FileContentSource } from "@tryaura/aura-sdk";

/** Neutral starter content used when Aura creates the canonical shared instruction source. */
export const SHARED_INSTRUCTIONS_TEMPLATE = "# Shared agent instructions\n";

function snippetSource(filename: string): FileContentSource {
  return {
    type: "file",
    url: new URL(`../content/snippets/${filename}`, import.meta.url).href,
  };
}

export default definePlugin({
  apiVersion: 1,
  // Deliberately not the package's "content-official": the plugin id namespaces every
  // user-facing snippet id, and "official/commit-conventions" is the intended spelling.
  id: "official",
  name: "Aura Official Content",
  snippets: [
    {
      category: "git",
      description: "Apply clear, consistent conventions to Git commits.",
      id: "official/commit-conventions",
      kind: "snippet",
      name: "Commit conventions",
      source: snippetSource("commit-conventions.md"),
      version: "1.0.0",
    },
    {
      category: "safety",
      description: "Require confirmation before destructive or irreversible operations.",
      id: "official/ask-before-destructive",
      kind: "snippet",
      name: "Ask before destructive operations",
      source: snippetSource("ask-before-destructive.md"),
      version: "1.0.0",
    },
    {
      category: "git",
      description: "Write pull request descriptions that explain intent and validation.",
      id: "official/pr-descriptions",
      kind: "snippet",
      name: "Pull request descriptions",
      source: snippetSource("pr-descriptions.md"),
      version: "1.0.0",
    },
    {
      category: "atlassian",
      description: "Keep Jira issue references consistent across development artifacts.",
      id: "official/jira-linking",
      kind: "snippet",
      name: "Jira issue linking",
      source: snippetSource("jira-linking.md"),
      version: "1.0.0",
    },
    {
      category: "atlassian",
      description: "Reference Confluence without hiding execution-critical context.",
      id: "official/confluence-references",
      kind: "snippet",
      name: "Confluence references",
      source: snippetSource("confluence-references.md"),
      version: "1.0.0",
    },
    {
      category: "language",
      description: "Apply strict and explicit TypeScript typing conventions.",
      id: "official/typescript-style",
      kind: "snippet",
      name: "TypeScript style",
      source: snippetSource("typescript-style.md"),
      version: "1.0.0",
    },
    {
      category: "language",
      description: "Apply typed Python conventions with consistent Ruff validation.",
      id: "official/python-style",
      kind: "snippet",
      name: "Python style",
      source: snippetSource("python-style.md"),
      version: "1.0.0",
    },
  ],
  version: "0.0.0",
});
