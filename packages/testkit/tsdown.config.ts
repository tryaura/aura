import { defineConfig } from "tsdown";

export default defineConfig({
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
