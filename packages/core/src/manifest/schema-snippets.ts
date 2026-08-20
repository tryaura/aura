import type { AuraManifestSnippet, JsonObject, JsonValue } from "@tryaura/aura-sdk";

import { invalid, requiredObject, requiredString, SHA256_PATTERN } from "./schema-values.js";

/**
 * The same grammar `CONTENT_ID_PATTERN` admits for a preset's snippet ids.
 *
 * Deliberately not stricter: a preset may name any id this pattern accepts, and a manifest that
 * refused one would fail on a selection the preset was allowed to make.
 */
const SNIPPET_ID_PATTERN = /^[a-z0-9][a-z0-9._/-]*$/u;

/**
 * Reads the install record for every snippet appended to the shared instructions.
 *
 * Two older shapes name an install that has to survive the read: the released record carried a
 * `pinned` revision Aura no longer holds content at, and an early install-once build wrote a bare
 * id. Both normalize to `{ id, hash? }` — the dead revision keys are dropped rather than carried
 * forward, and a record with no hash stays installed rather than being discarded for the shape.
 */
export function snippets(value: JsonValue | undefined): readonly AuraManifestSnippet[] {
  if (!Array.isArray(value)) {
    throw invalid("$.snippets", "must be an array");
  }

  const seen = new Set<string>();
  const installed: AuraManifestSnippet[] = [];
  for (const [index, candidate] of value.entries()) {
    const path = `$.snippets[${String(index)}]`;
    const record =
      typeof candidate === "string" ? { id: candidate } : requiredObject(candidate, path);
    const id = requiredString(record, "id", path);
    if (!SNIPPET_ID_PATTERN.test(id)) {
      throw invalid(`${path}.id`, 'must be a lowercase snippet id such as "acme/rules"');
    }
    const hash = optionalSnippetHash(record, path);
    // First occurrence wins: a duplicate is a damaged record, and the earlier one is the install.
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    installed.push(Object.freeze({ ...(hash === undefined ? {} : { hash }), id }));
  }
  return Object.freeze(installed);
}

function optionalSnippetHash(record: JsonObject, path: string): string | undefined {
  const hash = record["hash"];
  if (hash === undefined) {
    return undefined;
  }
  if (typeof hash !== "string" || !SHA256_PATTERN.test(hash)) {
    throw invalid(`${path}.hash`, "must be a lowercase SHA-256 hash");
  }
  return hash;
}
