import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function read(path) {
  return await readFile(join(ROOT, path), "utf8");
}

async function readManifest(path) {
  return JSON.parse(await read(path));
}

function major(version) {
  return version.split(".")[0];
}

describe("documented toolchain versions", () => {
  it("matches the machine-readable pins", async () => {
    const [
      nodePin,
      bunPin,
      rootManifest,
      webManifest,
      cliManifest,
      contributing,
      readme,
      distributions,
      install,
    ] = await Promise.all([
      read(".nvmrc"),
      read(".bun-version"),
      readManifest("package.json"),
      readManifest("apps/web/package.json"),
      readManifest("packages/cli/package.json"),
      read("CONTRIBUTING.md"),
      read("README.md"),
      read("apps/web/src/content/docs/docs/guides/distributions.mdx"),
      read("apps/web/src/content/docs/docs/installation.mdx"),
    ]);

    const nodeVersion = nodePin.trim();
    const bunVersion = bunPin.trim();
    const pnpmVersion = rootManifest.packageManager.replace(/^pnpm@/u, "");
    const rootTypeScriptVersion = rootManifest.devDependencies.typescript;
    const webTypeScriptVersion = webManifest.devDependencies.typescript;
    const releaseTag = `v${cliManifest.version}`;

    expect(contributing).toContain(`**Node.js ${major(nodeVersion)}**`);
    expect(contributing).toContain(`**pnpm ${pnpmVersion}**`);
    expect(contributing).toContain(`**Bun ${bunVersion}**`);
    expect(contributing).toContain(`root pins \`typescript\` ${rootTypeScriptVersion}`);
    expect(contributing).toContain(
      `\`apps/web\` pins its own \`typescript\` ${webTypeScriptVersion}`,
    );

    expect(readme).toContain(
      `Aura requires Node.js ${major(nodeVersion)} and pnpm ${major(pnpmVersion)}.`,
    );
    expect(readme).toContain(`the repository uses Node.js ${major(nodeVersion)} and pnpm.`);
    expect(distributions).toContain(
      `Use Node.js ${major(nodeVersion)}, pnpm, TypeScript, and Bun ${bunVersion}.`,
    );
    expect(install).toContain(`Node.js ${major(nodeVersion)} or newer only when`);
    expect(install).toContain("Install a specific tag");
    expect(install).toContain(`example \`${releaseTag}\``);
    expect(install).toContain(`AURA_INSTALL_DIR=/usr/local/bin AURA_VERSION=${releaseTag}`);
  });
});
