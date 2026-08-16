import { configStringArray, parseConfigObject, type AdapterSourceFile } from "@tryaura/aura-sdk";
import { parse } from "smol-toml";

const DEFAULT_PROJECT_DOC_MAX_BYTES = 32 * 1024;
export const DEFAULT_PROJECT_ROOT_MARKERS = Object.freeze([".git"]);

export interface CodexProjectSettings {
  readonly fallbackFilenames: readonly string[];
  readonly maxBytes: number;
  readonly rootMarkers: readonly string[];
}

/** Reads the Codex settings that change project-instruction discovery. */
export function parseCodexProjectSettings(
  file: AdapterSourceFile | undefined,
): CodexProjectSettings {
  const root = parseConfigObject(file?.content, parse);
  const fallbackFilenames = configuredNames(root?.["project_doc_fallback_filenames"]);
  const rootMarkers = configuredNames(root?.["project_root_markers"]);
  const maxBytes = root?.["project_doc_max_bytes"];

  return {
    fallbackFilenames: (fallbackFilenames ?? []).filter(
      (name) => name !== "AGENTS.override.md" && name !== "AGENTS.md",
    ),
    maxBytes:
      typeof maxBytes === "number" && Number.isSafeInteger(maxBytes) && maxBytes >= 0
        ? maxBytes
        : DEFAULT_PROJECT_DOC_MAX_BYTES,
    rootMarkers: rootMarkers ?? DEFAULT_PROJECT_ROOT_MARKERS,
  };
}

/** Codex accepts names, not paths; rejecting separators also keeps repository probes contained. */
function configuredNames(value: unknown): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const names = configStringArray(value);
  if (names === undefined) {
    return undefined;
  }

  return [
    ...new Set(
      names.filter((name) => name.length > 0 && !name.includes("/") && !name.includes("\\")),
    ),
  ];
}
