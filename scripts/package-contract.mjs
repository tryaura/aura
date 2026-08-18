import assert from "node:assert/strict";

const INSTALL_HOOKS = ["install", "postinstall", "preinstall", "prepare"];

/** What each published tarball is allowed and required to contain. */
export const PACKAGES = [
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
      /^package\/content\/mcp\/[^/]+\.json$/,
      /^package\/dist\//,
      /^package\/schema\/check-output-v1\.schema\.json$/,
    ],
    name: "@tryaura/aura-cli",
    path: "packages/cli",
    required: [
      "package/LICENSE",
      "package/README.md",
      "package/content/snippets/commit-conventions.md",
      "package/content/mcp/atlassian-rovo.json",
      "package/content/mcp/github.json",
      "package/content/mcp/sentry.json",
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

/** The only `@tryaura/` packages a published tarball may depend on. Everything else is private. */
const PUBLISHED_SCOPED_PACKAGES = new Set(["@tryaura/aura-cli", "@tryaura/aura-sdk"]);

function assertPublicDependencies(manifest) {
  const leaked = Object.keys(manifest.dependencies ?? {}).filter(
    (dependency) =>
      dependency.startsWith("@tryaura/") && !PUBLISHED_SCOPED_PACKAGES.has(dependency),
  );
  assert.deepEqual(leaked, [], `${manifest.name} leaks private dependencies`);
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

/** The surface each package promises consumers, keyed by name so adding one stays a local edit. */
const ENTRY_POINT_CONTRACTS = {
  "@tryaura/aura-sdk": (manifest) => {
    // `yaml` is the SDK's only runtime dependency — skill frontmatter is parsed with a real YAML
    // parser, imported rather than bundled so consumers dedupe one copy. Names only: a version
    // bump is a dependency update, not a change to what the package promises.
    assert.deepEqual(Object.keys(manifest.dependencies ?? {}), ["yaml"]);
    assert.deepEqual(Object.keys(manifest.exports).sort(), [".", "./testing"]);
  },
  "@tryaura/aura-cli": (manifest, expectedVersion) => {
    assert.deepEqual(manifest.bin, { aura: "./dist/bin/aura.js" });
    assert.deepEqual(Object.keys(manifest.exports).sort(), [
      ".",
      "./plugins",
      "./schema/check-output-v1.json",
    ]);
    assert.equal(manifest.dependencies["@tryaura/aura-sdk"], expectedVersion);
  },
  "@tryaura/aura-testkit": (manifest, expectedVersion) => {
    assert.deepEqual(Object.keys(manifest.exports), ["."]);
    assert.equal(manifest.dependencies["@tryaura/aura-cli"], expectedVersion);
    assert.equal(manifest.dependencies["@tryaura/aura-sdk"], expectedVersion);
  },
};

function assertEntryPoints(manifest, expectedVersion) {
  const contract = ENTRY_POINT_CONTRACTS[manifest.name];
  assert.ok(contract, `${manifest.name} has no declared entry-point contract`);
  contract(manifest, expectedVersion);
}

/** Everything one packed tarball must satisfy before it is fit to install anywhere. */
export function assertPackageTarball({ expectedVersion, files, manifest, packageSpec }) {
  assertAllowedFiles(packageSpec, files);
  assert.equal(manifest.name, packageSpec.name);
  assert.equal(manifest.version, expectedVersion);
  assertPublicDependencies(manifest);
  assertNoInstallHooks(manifest);
  assertEntryPoints(manifest, expectedVersion);
}
