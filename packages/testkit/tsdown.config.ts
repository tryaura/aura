import { defineConfig } from "tsdown";

export default defineConfig({
  attw: { level: "error", profile: "esm-only" },
  deps: {
    neverBundle: true,
    onlyImport: ["@tryaura/aura-cli", "@tryaura/aura-sdk", "diff"],
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
