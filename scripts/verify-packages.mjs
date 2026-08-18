/* eslint-disable no-restricted-imports, no-restricted-properties -- release verification owns its isolated process boundary */
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { contentEntrypoints } from "../examples/acme-distribution/content-entrypoints.mjs";
import { PACKAGES, assertPackageTarball } from "./package-contract.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE_PATH = "examples/acme-distribution";
const EXCLUDED_FROM_CONSUMER = new Set(["dist", "node_modules"]);
// Both pinned elsewhere: the toolchain in .bun-version (which CI also feeds to setup-bun), and the
// release version in the SDK manifest, which every other package is then asserted to match.
const BUN_VERSION = (await readFile(join(ROOT, ".bun-version"), "utf8")).trim();
const EXPECTED_VERSION = JSON.parse(
  await readFile(join(ROOT, "packages/sdk/package.json"), "utf8"),
).version;
// `tar -xO` streams whole bundles through stdout, and the CLI bundle is already a large fraction
// of Node's 1 MiB default. Exceeding it kills the child with an ENOBUFS error that reads as an
// unexplained tar failure, so give the capture room the bundle will not grow into.
const MAX_CAPTURED_BYTES = 256 * 1024 * 1024;
function run(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: MAX_CAPTURED_BYTES,
  });

  if (result.status !== 0) {
    throw new Error(
      [`${command} ${args.join(" ")} failed`, result.error?.message, result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return result.stdout.trim();
}

async function readManifest(path) {
  return JSON.parse(await readFile(join(ROOT, path, "package.json"), "utf8"));
}

async function main() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "aura-packages-"));
  const artifacts = join(temporaryRoot, "artifacts");
  const consumer = join(temporaryRoot, "consumer");

  try {
    await mkdir(artifacts);

    for (const packageSpec of PACKAGES) {
      const manifest = await readManifest(packageSpec.path);
      assert.equal(manifest.version, EXPECTED_VERSION, `${packageSpec.name} is not lockstep`);
      // No explicit build: each package's prepack rebuilds it. Packing through that hook is the
      // point, since it is what keeps a hand-run `pnpm publish` from shipping a stale bundle.
      run("pnpm", ["--filter", packageSpec.name, "pack", "--pack-destination", artifacts]);
    }

    const archives = (await readdir(artifacts)).filter((path) => path.endsWith(".tgz")).sort();
    assert.equal(archives.length, PACKAGES.length, "expected one tarball per public package");

    const archiveByName = new Map();
    for (const packageSpec of PACKAGES) {
      const archive = archives.find((path) => path.includes(packageSpec.name.split("/")[1]));
      assert.ok(archive, `missing tarball for ${packageSpec.name}`);

      const archivePath = join(artifacts, archive);
      const files = run("tar", ["-tzf", archivePath]).split("\n").filter(Boolean);
      const manifest = JSON.parse(run("tar", ["-xOf", archivePath, "package/package.json"]));

      assertPackageTarball({ expectedVersion: EXPECTED_VERSION, files, manifest, packageSpec });
      if (packageSpec.name === "@tryaura/aura-cli") {
        const runtimeFiles = files.filter((file) => file.endsWith(".js"));
        const runtime = run("tar", ["-xOf", archivePath, ...runtimeFiles]);
        assert.doesNotMatch(
          runtime,
          /@tryaura\/(?:adapter-|checks-core|content-official|core)/u,
          "CLI runtime still imports a private workspace package",
        );
      }
      archiveByName.set(packageSpec.name, archivePath);
    }

    const sdkArchive = archiveByName.get("@tryaura/aura-sdk");
    const cliArchive = archiveByName.get("@tryaura/aura-cli");
    const testkitArchive = archiveByName.get("@tryaura/aura-testkit");
    assert.ok(sdkArchive && cliArchive && testkitArchive);

    // `examples/acme-distribution` is a workspace member, so it carries a linked `node_modules` and
    // may carry a local `dist`. Copying either would defeat the point of installing from tarballs.
    await cp(join(ROOT, EXAMPLE_PATH), consumer, {
      filter: (source) => !EXCLUDED_FROM_CONSUMER.has(basename(source)),
      recursive: true,
    });
    const exampleManifest = await readManifest(EXAMPLE_PATH);
    await writeFile(
      join(consumer, "package.json"),
      `${JSON.stringify(
        {
          // An explicit pick, not a spread: the example's manifest is free to grow fields, and an
          // install hook arriving through one would run inside the very install this proves inert.
          name: "acmedev-clean-room",
          packageManager: exampleManifest.packageManager,
          private: true,
          type: exampleManifest.type,
          version: exampleManifest.version,
          dependencies: {
            "@tryaura/aura-cli": `file:${cliArchive}`,
            "@tryaura/aura-sdk": `file:${sdkArchive}`,
            "@tryaura/aura-testkit": `file:${testkitArchive}`,
          },
          devDependencies: {
            "@types/node": "24.13.3",
            typescript: "7.0.2",
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(consumer, "pnpm-workspace.yaml"),
      [
        "packages:",
        "  - .",
        "overrides:",
        `  "@tryaura/aura-cli": "file:${cliArchive}"`,
        `  "@tryaura/aura-sdk": "file:${sdkArchive}"`,
        `  "@tryaura/aura-testkit": "file:${testkitArchive}"`,
        "",
      ].join("\n"),
    );

    run(
      "pnpm",
      ["install", "--ignore-scripts", "--store-dir", join(temporaryRoot, "store")],
      consumer,
    );
    assert.equal(
      run(join(consumer, "node_modules/.bin/aura"), ["--version"], consumer),
      EXPECTED_VERSION,
    );
    run(join(consumer, "node_modules/.bin/tsc"), ["--project", "tsconfig.json"], consumer);
    await mkdir(join(consumer, "dist"));
    await cp(join(consumer, "node_modules/@tryaura/aura-cli/content"), join(consumer, "content"), {
      recursive: true,
    });
    const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
    const bunCommand = bunAvailable ? "bun" : "pnpm";
    const bunArguments = bunAvailable ? [] : ["dlx", `bun@${BUN_VERSION}`];
    // The same list `build.mjs` derives, so the binary CI verifies embeds exactly the files the
    // example's own build embeds. Only the Bun launcher differs, because CI may not have Bun.
    const contentEntries = await contentEntrypoints(consumer);
    run(
      bunCommand,
      [
        ...bunArguments,
        "build",
        "src/main.ts",
        ...contentEntries,
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
      consumer,
    );
    assert.equal(run(join(consumer, "dist/acmedev"), ["--version"], consumer), EXPECTED_VERSION);
    run("node", ["smoke.mjs"], consumer);

    process.stdout.write(
      `Verified release-ready ${EXPECTED_VERSION} tarballs and examples/acme-distribution.\n`,
    );
  } finally {
    if (process.env.AURA_KEEP_PACKAGE_TEMP === "1") {
      process.stderr.write(`Preserved package verification directory: ${temporaryRoot}\n`);
    } else {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  }
}

await main();
