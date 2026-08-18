import { defineConfig } from "tsdown";

export default defineConfig({
  attw: { level: "error", profile: "esm-only" },
  deps: {
    neverBundle: true,
    onlyImport: ["yaml"],
  },
  dts: true,
  entry: {
    index: "src/index.ts",
    testing: "src/testing.ts",
  },
  fixedExtension: false,
  format: "esm",
  platform: "node",
  publint: { level: "error" },
  sourcemap: false,
  target: "node24",
  tsconfig: "tsconfig.build.json",
});
