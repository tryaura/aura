import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { AuraEffectivePreset, AuraTeamPreset, Environment, Preset } from "@tryaura/aura-sdk";

import { MAX_TEAM_PRESET_BYTES } from "../workspace/reader-limits.js";
import { createFileReader, type FileReader } from "../workspace/reader.js";
import { readPresetCache, writePresetCache } from "./cache.js";
import { loadNpmPreset } from "./npm.js";
import { validateTeamPreset } from "./schema.js";

const NPM_PREFIX = "npm:";
const PLUGIN_PREFIX = "plugin:";

export interface TeamPresetLoadOptions {
  readonly cliReference?: string | undefined;
  readonly defaultReference?: string | undefined;
  readonly environment: Environment;
  readonly manifestReference?: string | undefined;
  readonly noCache?: boolean | undefined;
  /**
   * Whether to refuse network fetches, resolving remote references from cache only.
   *
   * A run that was not put online should not acquire network access by way of its configuration.
   * Local and bundled references are unaffected; a remote one falls back to its cached copy and
   * fails with a note when there is none.
   */
  readonly offline?: boolean | undefined;
  readonly presets?: readonly Preset[] | undefined;
  readonly reader?: FileReader | undefined;
}

export type LoadedTeamPreset =
  | { readonly status: "missing" }
  | { readonly message: string; readonly status: "invalid" }
  | {
      /** Non-fatal problems from the load, such as a remote reference served from cache. */
      readonly notes: readonly string[];
      /**
       * The reference as the user would recognize it, which is what consent surfaces quote.
       *
       * The resolved {@link AuraEffectivePreset.reference} can be an absolute path nobody typed;
       * this is the form that was selected — `npm:@acme/preset@1.2.0`, a URL, or `.aura/preset.json`.
       */
      readonly origin: string;
      readonly preset: AuraTeamPreset;
      readonly selected: AuraEffectivePreset;
      readonly status: "ready";
    };

/** Selects and loads one runtime team preset without importing or executing its package. */
export async function loadTeamPreset(options: TeamPresetLoadOptions): Promise<LoadedTeamPreset> {
  const reader = options.reader ?? createFileReader();
  const selection = selectReference(options);
  if (selection === undefined) {
    return { status: "missing" };
  }

  const loaded = await loadReference(selection.reference, options, reader);
  if (loaded.status === "invalid") {
    return loaded;
  }
  const parsed = parsePresetText(loaded.text, selection.label);
  if (parsed.status === "invalid") {
    return parsed;
  }
  if (loaded.remote && options.noCache !== true) {
    await writePresetCache(options.environment, selection.reference, loaded.text);
  }
  return {
    notes: loaded.notes,
    origin: selection.label,
    preset: parsed.preset,
    selected: Object.freeze({
      name: parsed.preset.name ?? selection.label,
      reference: selection.reference,
    }),
    status: "ready",
  };
}

interface PresetSelection {
  readonly label: string;
  readonly reference: string;
}

/**
 * Picks the team-preset reference: `--preset`, then the manifest, then the distro default.
 *
 * The repository's `.aura/preset.json` is deliberately not a candidate — it is its own
 * configuration layer above whichever preset is selected here, applied only after the user
 * trusted it for the repository.
 */
function selectReference(options: TeamPresetLoadOptions): PresetSelection | undefined {
  if (options.cliReference !== undefined) {
    return { label: options.cliReference, reference: options.cliReference };
  }
  if (options.manifestReference !== undefined) {
    return { label: options.manifestReference, reference: options.manifestReference };
  }
  return options.defaultReference === undefined
    ? undefined
    : { label: options.defaultReference, reference: options.defaultReference };
}

type LoadedReference =
  | { readonly message: string; readonly status: "invalid" }
  | {
      readonly notes: readonly string[];
      readonly remote: boolean;
      readonly status: "ready";
      readonly text: string;
    };

// fallow-ignore-next-line complexity -- dispatches and validates each explicit preset reference scheme.
async function loadReference(
  reference: string,
  options: TeamPresetLoadOptions,
  reader: FileReader,
): Promise<LoadedReference> {
  if (reference.startsWith(PLUGIN_PREFIX)) {
    return loadPluginPreset(reference.slice(PLUGIN_PREFIX.length), options.presets ?? [], reader);
  }
  if (reference.startsWith(NPM_PREFIX)) {
    return loadRemote(reference, options, async () =>
      remote(await loadNpmPreset(reference.slice(NPM_PREFIX.length), options.environment)),
    );
  }
  if (reference.startsWith("https://")) {
    try {
      const url = new URL(reference);
      if (url.username !== "" || url.password !== "") {
        return failure("Preset URL references must not contain credentials.");
      }
      return loadRemote(reference, options, () => loadUrlPreset(reference, options.environment));
    } catch {
      return failure("Preset URL reference is invalid.");
    }
  }
  if (reference.startsWith("http://")) {
    return failure("Preset URL references must use HTTPS.");
  }
  if (reference.startsWith("file:")) {
    try {
      return loadPath(fileURLToPath(new URL(reference)), reader);
    } catch {
      return failure("Preset file reference is invalid.");
    }
  }
  return loadPath(resolve(options.environment.cwd, reference), reader);
}

/** Serves a remote reference from cache when possible, and refuses to fetch when offline. */
async function loadRemote(
  reference: string,
  options: TeamPresetLoadOptions,
  fetcher: () => Promise<LoadedReference>,
): Promise<LoadedReference> {
  if (options.noCache !== true) {
    const cached = await readPresetCache(options.environment, reference);
    if (cached !== undefined) {
      return { notes: [], remote: false, status: "ready", text: cached };
    }
  }
  if (options.offline === true) {
    return failure(
      `Team preset ${reference} is not cached and this run is offline. ` +
        "Re-run with --online to fetch it.",
    );
  }
  return fetcher();
}

async function loadPluginPreset(
  id: string,
  presets: readonly Preset[],
  reader: FileReader,
): Promise<LoadedReference> {
  const preset = presets.find((candidate) => candidate.id === id);
  if (preset === undefined) {
    return failure(`Unknown bundled preset ${id}.`);
  }
  try {
    const url = new URL(preset.source.url);
    if (url.protocol !== "file:") {
      return failure(`Bundled preset ${id} does not use a file: source.`);
    }
    return loadPath(fileURLToPath(url), reader);
  } catch {
    return failure(`Bundled preset ${id} has an invalid source.`);
  }
}

async function loadPath(path: string, reader: FileReader): Promise<LoadedReference> {
  const contents = await reader.read(path, { maxBytes: MAX_TEAM_PRESET_BYTES });
  if (!contents.exists) {
    return failure(`Team preset ${path} does not exist.`);
  }
  if (
    contents.problem !== undefined ||
    contents.isDirectory ||
    contents.content === undefined ||
    (contents.size ?? 0) > MAX_TEAM_PRESET_BYTES
  ) {
    return failure(`Team preset ${path} is not a readable bounded file.`);
  }
  return { notes: [], remote: false, status: "ready", text: contents.content };
}

async function loadUrlPreset(
  reference: string,
  environment: Environment,
): Promise<LoadedReference> {
  const result = await environment.httpGet({
    maxResponseBytes: MAX_TEAM_PRESET_BYTES,
    url: reference,
  });
  if (result.kind === "failure") {
    return failure(`Team preset request failed (${result.reason}).`);
  }
  if (result.kind !== "response" || result.status !== 200) {
    return failure("Team preset request did not return a successful JSON response.");
  }
  return { notes: [], remote: true, status: "ready", text: result.body };
}

function remote(
  result: { problem: string; status: "invalid" } | { status: "ready"; text: string },
): LoadedReference {
  return result.status === "invalid"
    ? failure(result.problem)
    : { notes: [], remote: true, status: "ready", text: result.text };
}

function parsePresetText(
  text: string,
  label: string,
):
  | { readonly message: string; readonly status: "invalid" }
  | { readonly preset: AuraTeamPreset; readonly status: "ready" } {
  if (Buffer.byteLength(text, "utf8") > MAX_TEAM_PRESET_BYTES) {
    return failure(`Team preset ${label} exceeds the preset size limit.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return failure(`Team preset ${label} is not valid JSON.`);
  }
  const parsed = validateTeamPreset(value);
  return parsed.kind === "invalid"
    ? failure(`Team preset ${label} is invalid at ${parsed.problem}.`)
    : { preset: parsed.preset, status: "ready" };
}

function failure(message: string): { readonly message: string; readonly status: "invalid" } {
  return { message, status: "invalid" };
}
