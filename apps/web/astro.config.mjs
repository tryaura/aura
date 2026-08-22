// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

/**
 * Docs live under `src/content/docs/docs/**` rather than `src/content/docs/**` directly.
 *
 * Starlight maps the collection to routes relative to `src/content/docs`, so the extra `docs`
 * folder is what serves the handbook at `/docs/*` and leaves `/` free for the marketing page in
 * `src/pages/index.astro`. Flattening the folder would collide with that page.
 */
export default defineConfig({
  site: "https://tryaura.sh",
  /**
   * Published slugs are a contract with every link already pointing at them.
   *
   * A renamed page keeps an entry here, because the deployment serves static assets with no route
   * fallback: without the redirect the old URL becomes a 404 for search results and bookmarks.
   */
  redirects: {
    "/docs/guides/repository-provided-content": "/docs/guides/repository-content/",
    "/docs/guides/internal-distribution": "/docs/guides/ship-a-distribution/",
  },
  integrations: [
    starlight({
      title: "Aura",
      description: "Keep every coding agent in your repo working from the same rules.",
      favicon: "/favicon.svg",
      disable404Route: true,
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/tryaura/aura" }],
      editLink: {
        baseUrl: "https://github.com/tryaura/aura/edit/main/apps/web/",
      },
      customCss: ["./src/styles/docs.css"],
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "Introduction", slug: "docs/introduction" },
            { label: "Install Aura", slug: "docs/installation" },
            { label: "Quickstart", slug: "docs/quickstart" },
          ],
        },
        {
          label: "Use Aura",
          items: [
            { label: "Set up and converge", slug: "docs/guides/setup" },
            { label: "Understand and fix findings", slug: "docs/guides/check-and-fix" },
            { label: "Manage content", slug: "docs/guides/managed-content" },
            { label: "Undo and recover", slug: "docs/guides/undo-and-recover" },
            { label: "Troubleshooting", slug: "docs/troubleshooting" },
          ],
        },
        {
          label: "Configure teams",
          items: [
            { label: "Share repository content", slug: "docs/guides/repository-content" },
            { label: "Configure a team preset", slug: "docs/guides/team-presets" },
          ],
        },
        {
          label: "Extend Aura",
          items: [
            { label: "Build a distribution", slug: "docs/guides/distributions" },
            { label: "Ship a distribution", slug: "docs/guides/ship-a-distribution" },
            { label: "Plugins", slug: "docs/reference/plugins" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "CLI", slug: "docs/reference/cli" },
            { label: "Check catalog", slug: "docs/reference/checks" },
            { label: "Check JSON and exit codes", slug: "docs/reference/check-json" },
            { label: "Desired-state manifest", slug: "docs/reference/manifest" },
            { label: "Team preset schema", slug: "docs/reference/team-preset" },
            { label: "MCP catalog", slug: "docs/reference/mcp-catalog" },
          ],
        },
      ],
    }),
  ],
});
