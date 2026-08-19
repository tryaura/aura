/* eslint-disable no-restricted-properties -- documentation generation owns its process boundary */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { renderSupportedApps, replaceSupportedAppsFragment } from "./supported-apps-table.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME_SENTINEL = "/home/aura-docs";
const WORKSPACE_SENTINEL = "/workspace/aura-docs";
const DOCUMENT_PATHS = ["README.md", "apps/web/src/content/docs/docs/installation.md"];

/**
 * Every machine shape an adapter can branch on, so a path declared for only some of them is
 * documented as such rather than silently omitted.
 *
 * The `present` axis matters because adapters expand their declarations as files turn up — Codex
 * only names project instruction candidates once it has read `config.toml`. Discovering against an
 * empty filesystem alone would document the paths Aura reads on a bare machine and nothing else.
 */
const PLATFORMS = ["darwin", "linux", "win32"];
const PRESENCE = [false, true];

function documentationEnvironment(platform) {
  const unavailable = async () => {
    throw new Error("Adapter file discovery must not perform I/O.");
  };

  return {
    cwd: WORKSPACE_SENTINEL,
    exec: unavailable,
    homeDir: HOME_SENTINEL,
    httpGet: unavailable,
    now: () => {
      throw new Error("Adapter file discovery must not read the clock.");
    },
    pathEntries: [],
    platform,
    readVariable: () => {
      throw new Error("Adapter file discovery must not read environment variables.");
    },
  };
}

/**
 * A filesystem where every path is uniformly absent or uniformly present but empty.
 *
 * Empty content is what makes the present variant safe to run: an adapter parses it into its
 * defaults and declares the paths those defaults point at, without the generator having to invent
 * plausible configuration for every application it documents.
 */
function stubReader(present) {
  const contents = present
    ? { content: "", exists: true, isDirectory: false, pathKind: "file", size: 0 }
    : { exists: false, isDirectory: false };

  return {
    exists: async () => present,
    read: async () => contents,
    realPath: async (path) => (present ? path : undefined),
  };
}

export function normalizeDocumentationPath(path) {
  for (const [prefix, replacement] of [
    [HOME_SENTINEL, "~"],
    [WORKSPACE_SENTINEL, "."],
  ]) {
    if (path === prefix) {
      return replacement;
    }
    if (path.startsWith(`${prefix}/`)) {
      return `${replacement}${path.slice(prefix.length)}`;
    }
  }

  throw new Error(`Adapter declared path outside the documentation roots: ${path}`);
}

/**
 * Reconciles two kinds declared for one path.
 *
 * A probe is a metadata-only look that an adapter promotes to a real read once it selects the
 * candidate, so the same path legitimately arrives under both kinds. The read wins: a reader wants
 * to know Aura may open the file, not that it first checked whether it was there. Any other
 * disagreement is the adapter contradicting itself, and the table would have to pick one silently.
 */
function mergedKind(adapter, path, previous, next) {
  if (previous === next || next === "probe") {
    return previous;
  }
  if (previous !== "probe") {
    throw new Error(`Adapter ${adapter.id} declared ${path} as both ${previous} and ${next}.`);
  }
  return next;
}

function recordPath(found, adapter, spec, platform) {
  const path = normalizeDocumentationPath(spec.path);
  const previous = found.get(path);
  if (previous === undefined) {
    found.set(path, { kind: spec.kind, path, platforms: new Set([platform]) });
    return;
  }
  previous.kind = mergedKind(adapter, path, previous.kind, spec.kind);
  previous.platforms.add(platform);
}

/**
 * Runs core's own discovery loop over every machine shape and merges what each declared.
 *
 * Discovery is core's to define — its round cap and its rule for when a redeclared spec counts as
 * the same slot are the contract adapters are held to at scan time. A second implementation here
 * could accept an adapter that no real scan does, and document paths Aura never reads.
 */
export async function discoverAdapterPaths(adapter, discover) {
  const found = new Map();

  for (const platform of PLATFORMS) {
    for (const present of PRESENCE) {
      const { files } = await discover(adapter, {
        detection: { installed: true },
        environment: documentationEnvironment(platform),
        projectBoundary: undefined,
        projectRoot: WORKSPACE_SENTINEL,
        reader: stubReader(present),
      });
      for (const file of files.values()) {
        recordPath(found, adapter, file.spec, platform);
      }
    }
  }

  return [...found.values()].map(({ kind, path, platforms }) => ({
    kind,
    path,
    ...(platforms.size === PLATFORMS.length ? {} : { platforms: [...platforms].sort() }),
  }));
}

export async function supportedAppsFromRegistry(registry, discover) {
  const apps = [];

  for (const adapter of registry.adapters) {
    if (adapter.synthetic === true) {
      continue;
    }
    apps.push({
      displayName: adapter.displayName,
      id: adapter.id,
      paths: await discoverAdapterPaths(adapter, discover),
      supportedRange: adapter.supportedRange,
    });
  }

  return apps;
}

/**
 * Loads the built official registry.
 *
 * The generator reads compiled output rather than source so that it documents the same adapter
 * code the released binary runs.
 */
async function officialSupportedApps() {
  const [plugins, core] = await Promise.all([
    load("../packages/cli/dist/plugins/index.js"),
    load("../packages/core/dist/index.js"),
  ]);
  const registry = core.createPluginRegistry(
    plugins.OFFICIAL_PLUGINS,
    plugins.OFFICIAL_REGISTRY_OPTIONS,
  );
  return supportedAppsFromRegistry(registry, core.discoverAdapterFiles);
}

async function load(specifier) {
  try {
    return await import(specifier);
  } catch (cause) {
    throw new Error(`Cannot read ${specifier}. Run pnpm build first.`, { cause });
  }
}

export async function synchronizeSupportedAppsDocs({ write }) {
  const fragment = renderSupportedApps(await officialSupportedApps());
  const changed = [];

  for (const path of DOCUMENT_PATHS) {
    const absolutePath = join(ROOT, path);
    const source = await readFile(absolutePath, "utf8");
    const generated = replaceSupportedAppsFragment(source, fragment);
    if (generated === source) {
      continue;
    }
    changed.push(path);
    if (write) {
      await writeFile(absolutePath, generated, "utf8");
    }
  }

  return changed;
}

function report(mode, changed) {
  if (mode === "--write") {
    return changed.length === 0
      ? "Supported-app documentation is already current."
      : `Updated ${changed.join(", ")}.`;
  }
  if (changed.length === 0) {
    return `Verified ${String(DOCUMENT_PATHS.length)} supported-app documents.`;
  }
  throw new Error(
    `Generated supported-app documentation is stale: ${changed.join(", ")}. Run pnpm docs:generate-supported-apps.`,
  );
}

async function main() {
  const mode = process.argv[2];
  if (mode !== "--check" && mode !== "--write") {
    throw new Error("Usage: node scripts/supported-apps-docs.mjs --check|--write");
  }
  return report(mode, await synchronizeSupportedAppsDocs({ write: mode === "--write" }));
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  try {
    process.stdout.write(`${await main()}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
