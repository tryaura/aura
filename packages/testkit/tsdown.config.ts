import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";

const source = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // `@tryaura/core` is private and unbuilt: its export map resolves to `dist/`, which only exists
  // after a workspace-wide build. `pnpm pack` runs testkit's prepack alone, so alias the bundled
  // internals to source the way the CLI does, or the import survives into the tarball.
  alias: { "@tryaura/core": source("../../packages/core/src/index.ts") },
  attw: { level: "error", profile: "esm-only" },
  deps: {
    // Every dependency of the bundled `@tryaura/core`, not just the ones it reaches today: an
    // omission here emits a bare import into the tarball for a package testkit does not declare,
    // and neither attw nor publint inspects runtime imports for undeclared dependencies.
    alwaysBundle: ["@tryaura/core", "diff", "semver", "undici"],
    dts: { neverBundle: true },
    neverBundle: true,
    onlyBundle: false,
    onlyImport: ["@tryaura/aura-cli", "@tryaura/aura-sdk"],
  },
  dts: true,
  entry: { index: "src/index.ts" },
  fixedExtension: false,
  format: "esm",
  platform: "node",
  publint: { level: "error" },
  sourcemap: false,
  target: "node24",
  tsconfig: "tsconfig.build.json",
});
