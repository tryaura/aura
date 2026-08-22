import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { contentEntrypoints } from "./content-entrypoints.mjs";

const root = dirname(fileURLToPath(import.meta.url));

/**
 * `[dir]/[name].[ext]` preserves the `content/...` layout inside the executable, which is the
 * layout `pluginContentUrl` resolves against at runtime. Flattening it would strand every source.
 */
const result = spawnSync(
  "bun",
  [
    "build",
    // The standalone entry: the only one that declares the installation capability the updater
    // needs, so the compiled artifact is the only one that can replace itself.
    "src/standalone-main.boundary.ts",
    ...(await contentEntrypoints(root)),
    "--compile",
    "--asset-naming=[dir]/[name].[ext]",
    "--loader",
    ".md:file",
    "--loader",
    ".json:file",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    "--outfile",
    "dist/acmedev",
  ],
  { cwd: root, stdio: "inherit" },
);

process.exit(result.status ?? 1);
