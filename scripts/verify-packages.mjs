/* eslint-disable no-restricted-imports, no-restricted-properties -- release verification owns its isolated process boundary */
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
const INSTALL_HOOKS = ["install", "postinstall", "preinstall", "prepare"];
const PACKAGES = [
  {
    allowed: [/^package\/(?:LICENSE|README\.md|package\.json)$/, /^package\/dist\//],
    name: "@tryaura/aura-sdk",
    path: "packages/sdk",
    required: [
      "package/LICENSE",
      "package/README.md",
      "package/dist/index.d.ts",
      "package/dist/index.js",
      "package/dist/testing.d.ts",
      "package/dist/testing.js",
    ],
  },
  {
    allowed: [
      /^package\/(?:LICENSE|README\.md|package\.json)$/,
      /^package\/content\/snippets\/[^/]+\.md$/,
      /^package\/dist\//,
      /^package\/schema\/check-output-v1\.schema\.json$/,
    ],
    name: "@tryaura/aura-cli",
    path: "packages/cli",
    required: [
      "package/LICENSE",
      "package/README.md",
      "package/content/snippets/commit-conventions.md",
      "package/dist/bin/aura.js",
      "package/dist/index.d.ts",
      "package/dist/index.js",
      "package/dist/plugins/index.d.ts",
      "package/dist/plugins/index.js",
      "package/schema/check-output-v1.schema.json",
    ],
  },
  {
    allowed: [/^package\/(?:LICENSE|README\.md|package\.json)$/, /^package\/dist\//],
    name: "@tryaura/aura-testkit",
    path: "packages/testkit",
    required: [
      "package/LICENSE",
      "package/README.md",
      "package/dist/index.d.ts",
      "package/dist/index.js",
    ],
  },
];

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

function assertAllowedFiles(packageSpec, files) {
  for (const file of files) {
    assert.ok(
      packageSpec.allowed.some((pattern) => pattern.test(file)),
      `${packageSpec.name} includes unexpected tarball file ${file}`,
    );
  }
  for (const required of packageSpec.required) {
    assert.ok(files.includes(required), `${packageSpec.name} is missing ${required}`);
  }
}

function assertPublicDependencies(manifest) {
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    if (dependency.startsWith("@tryaura/")) {
      assert.ok(
        dependency === "@tryaura/aura-cli" || dependency === "@tryaura/aura-sdk",
        `${manifest.name} leaks private dependency ${dependency}`,
      );
    }
  }
}

/**
 * A published package that runs code on install would execute during the very step this harness
 * uses to prove the tarballs are inert, so the harness installs with `--ignore-scripts` and refuses
 * to ship a manifest that would have needed them.
 */
function assertNoInstallHooks(manifest) {
  for (const hook of INSTALL_HOOKS) {
    assert.ok(
      manifest.scripts?.[hook] === undefined,
      `${manifest.name} declares a ${hook} script, which would run on every consumer's install`,
    );
  }
}

function assertPackageContract(manifest) {
  if (manifest.name === "@tryaura/aura-sdk") {
    assert.deepEqual(manifest.dependencies ?? {}, {});
    assert.deepEqual(Object.keys(manifest.exports).sort(), [".", "./testing"]);
  }
  if (manifest.name === "@tryaura/aura-cli") {
    assert.deepEqual(manifest.bin, { aura: "./dist/bin/aura.js" });
    assert.deepEqual(Object.keys(manifest.exports).sort(), [
      ".",
      "./plugins",
      "./schema/check-output-v1.json",
    ]);
    assert.equal(manifest.dependencies["@tryaura/aura-sdk"], EXPECTED_VERSION);
  }
  if (manifest.name === "@tryaura/aura-testkit") {
    assert.deepEqual(Object.keys(manifest.exports), ["."]);
    assert.equal(manifest.dependencies["@tryaura/aura-cli"], EXPECTED_VERSION);
    assert.equal(manifest.dependencies["@tryaura/aura-sdk"], EXPECTED_VERSION);
  }
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

      assertAllowedFiles(packageSpec, files);
      assert.equal(manifest.name, packageSpec.name);
      assert.equal(manifest.version, EXPECTED_VERSION);
      assertPublicDependencies(manifest);
      assertNoInstallHooks(manifest);
      assertPackageContract(manifest);
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

    await cp(join(ROOT, "scripts/fixtures/distro-consumer"), consumer, { recursive: true });
    await writeFile(
      join(consumer, "package.json"),
      `${JSON.stringify(
        {
          dependencies: {
            "@tryaura/aura-cli": `file:${cliArchive}`,
            "@tryaura/aura-sdk": `file:${sdkArchive}`,
            "@tryaura/aura-testkit": `file:${testkitArchive}`,
          },
          devDependencies: {
            "@types/node": "24.13.3",
            typescript: "7.0.2",
          },
          name: "acmedev-clean-room",
          packageManager: "pnpm@11.21.0",
          private: true,
          type: "module",
          version: "0.0.0",
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
    const snippetEntries = (await readdir(join(consumer, "content/snippets")))
      .sort()
      .map((filename) => `content/snippets/${filename}`);
    run(
      bunCommand,
      [
        ...bunArguments,
        "build",
        "src/main.ts",
        ...snippetEntries,
        "--compile",
        "--asset-naming=content/snippets/[name].[ext]",
        "--loader",
        ".md:file",
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
      "Verified release-ready 0.1.0 tarballs and the acmedev clean-room distro.\n",
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
