import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";

const INTERNAL_PACKAGES = [
  "@tryaura/adapter-claude-code",
  "@tryaura/adapter-codex",
  "@tryaura/adapter-cursor",
  "@tryaura/checks-core",
  "@tryaura/content-official",
  "@tryaura/core",
  "@tryaura/core/display-path",
  "@tryaura/core/pluralize",
];

const RUNTIME_PACKAGES = [
  "@tryaura/aura-sdk",
  "clipanion",
  "diff",
  "ignore",
  "semver",
  "smol-toml",
  "string-width",
  "toml-eslint-parser",
  "typanion",
  "undici",
];

const source = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  alias: {
    "@tryaura/adapter-claude-code": source("../../plugins/adapter-claude-code/src/index.ts"),
    "@tryaura/adapter-codex": source("../../plugins/adapter-codex/src/index.ts"),
    "@tryaura/adapter-cursor": source("../../plugins/adapter-cursor/src/index.ts"),
    "@tryaura/checks-core": source("../../plugins/checks-core/src/index.ts"),
    "@tryaura/content-official": source("../../plugins/content-official/src/index.ts"),
    "@tryaura/core/display-path": source("../../packages/core/src/display-path.ts"),
    "@tryaura/core/pluralize": source("../../packages/core/src/pluralize.ts"),
    "@tryaura/core": source("../../packages/core/src/index.ts"),
  },
  clean: ["dist", "content"],
  copy: [
    {
      from: "../../plugins/content-official/content/snippets/**/*",
      to: "content/snippets",
    },
    {
      from: "../../plugins/content-official/content/mcp/**/*",
      to: "content/mcp",
    },
  ],
  deps: {
    alwaysBundle: INTERNAL_PACKAGES,
    dts: { neverBundle: true },
    neverBundle: true,
    onlyImport: RUNTIME_PACKAGES,
  },
  dts: false,
  entry: {
    "bin/aura": "src/bin.ts",
    index: "src/index.ts",
    "plugins/index": "src/plugins.ts",
  },
  fixedExtension: false,
  format: "esm",
  platform: "node",
  sourcemap: false,
  target: "node24",
  tsconfig: "tsconfig.build.json",
});
