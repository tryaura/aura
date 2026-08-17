import { defineConfig } from "tsdown";

export default defineConfig({
  attw: { level: "error", profile: "esm-only" },
  clean: false,
  deps: {
    dts: { neverBundle: true },
    neverBundle: true,
  },
  dts: { emitDtsOnly: true, sideEffects: false },
  entry: {
    "bin/aura": "src/bin.ts",
    index: "src/index.release.ts",
    "plugins/index": "src/plugins.ts",
  },
  fixedExtension: false,
  format: "esm",
  platform: "node",
  publint: { level: "error" },
  sourcemap: false,
  target: "node24",
  tsconfig: "tsconfig.build.json",
});
