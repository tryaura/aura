/**
 * The module URL prefix Bun gives every module inside a `bun build --compile` executable.
 *
 * Bun mounts the bundled JavaScript and every asset under one virtual root, so a compiled plugin
 * module sits beside `content/` rather than one level below it the way the source tree does. This
 * is a Bun implementation detail rather than a documented API; core spells the same root without
 * the URL scheme in `embedded-assets.ts`, and both have to move together if Bun renames it.
 */
const EMBEDDED_MODULE_PREFIX = "file:///$bunfs/";

/**
 * Builds the absolute `file:` URL of one bundled content file, in dev and in a compiled binary.
 *
 * A plugin's content lives at `content/` beside `src/`, so `../content/` resolves it from a module
 * in `src/`. A compiled executable flattens that: the module and `content/` share the embedded
 * root, so the same file is `./content/`. Picking between the two by hand means a plugin that
 * resolves under `bun run` and breaks only in the shipped executable, which is why this exists.
 *
 * ```ts
 * source: { type: "directory", url: pluginContentUrl(import.meta.url, "skills/release/") },
 * ```
 *
 * @param moduleUrl `import.meta.url` of the plugin module declaring the source.
 * @param path Path below `content/`, with a trailing slash for a directory source.
 */
export function pluginContentUrl(moduleUrl: string, path: string): string {
  const base = moduleUrl.startsWith(EMBEDDED_MODULE_PREFIX) ? "./content/" : "../content/";
  return new URL(`${base}${path}`, moduleUrl).href;
}
