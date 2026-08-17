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
  integrations: [
    starlight({
      title: "Aura",
      description: "Keep every coding agent in your repo working from the same rules.",
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
            { label: "Installation", slug: "docs/installation" },
          ],
        },
        {
          label: "Guides",
          items: [{ label: "Author a distribution", slug: "docs/guides/distributions" }],
        },
        {
          label: "Reference",
          items: [{ autogenerate: { directory: "docs/reference" } }],
        },
      ],
    }),
  ],
});
