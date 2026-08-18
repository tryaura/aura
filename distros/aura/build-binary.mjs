import { spawnSync } from "node:child_process";
import { cp, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(root, "..", "..");
const content = join(root, "content");

try {
  await rm(content, { force: true, recursive: true });
  await cp(join(repositoryRoot, "plugins", "content-official", "content"), content, {
    recursive: true,
  });
  const entries = (await readdir(content, { recursive: true }))
    .filter((path) => path.endsWith(".md") || path.endsWith(".json"))
    .map((path) => `content/${path.replaceAll("\\", "/")}`)
    .sort();
  const bun = await bunCommand(repositoryRoot);
  const result = spawnSync(
    bun.command,
    [
      ...bun.prefix,
      "build",
      "src/main.ts",
      ...entries,
      "--compile",
      "--minify",
      "--asset-naming=[dir]/[name].[ext]",
      "--loader",
      ".md:file",
      "--loader",
      ".json:file",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--outfile",
      "dist/aura",
    ],
    { cwd: root, stdio: "inherit" },
  );
  process.exitCode = result.status ?? 1;
} finally {
  await rm(content, { force: true, recursive: true });
}

async function bunCommand(repositoryDirectory) {
  if (spawnSync("bun", ["--version"]).status === 0) {
    return { command: "bun", prefix: [] };
  }
  const version = (await readFile(join(repositoryDirectory, ".bun-version"), "utf8")).trim();
  return { command: "pnpm", prefix: ["dlx", `bun@${version}`] };
}
