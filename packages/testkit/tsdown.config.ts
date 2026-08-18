import { defineConfig } from "tsdown";

export default defineConfig({
  attw: { level: "error", profile: "esm-only" },
  deps: {
    alwaysBundle: ["@tryaura/core", "diff", "semver"],
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
