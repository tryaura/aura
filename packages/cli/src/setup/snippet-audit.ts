import type { AuraManifestSnippet } from "@tryaura/aura-sdk";
import { AURA_MANIFEST_PATH, hashContent } from "@tryaura/core";

import type { SnippetCatalogEntry } from "./snippets.js";

/**
 * What became of the text Aura appended for each installed snippet.
 *
 * Aura writes no markers, so once a fragment is in the shared file nothing on disk distinguishes
 * it from the user's own guidance. The manifest's recorded hash is the only handle left: it says
 * whether the plugin still offers the text that was installed, and — while it does — whether that
 * text is still in the file at all. Without these two lines an installed snippet that was edited
 * away is a row that reads `installed` over a file that does not contain it.
 */
export function installedSnippetNotes(
  installed: readonly AuraManifestSnippet[],
  catalog: readonly SnippetCatalogEntry[],
  sharedPath: string,
  sharedContent: string,
): readonly string[] {
  const byId = new Map(catalog.map((entry) => [entry.id, entry]));
  return installed.flatMap((record) => {
    const entry = byId.get(record.id);
    // A record with no hash predates Aura keeping one, and an absent plugin has no text to compare
    // against; neither is drift, and reporting them as such would cry wolf on every run.
    if (record.hash === undefined || entry?.status !== "available") {
      return [];
    }
    if (hashContent(entry.content) !== record.hash) {
      return [
        `${record.id} was installed from an earlier version of its source. Aura leaves the text in ${sharedPath} as it is.`,
      ];
    }
    return containsFragment(sharedContent, entry.content)
      ? []
      : [
          `${record.id} is recorded as installed, but its text is no longer in ${sharedPath}. Aura keeps the record; drop its entry from ${AURA_MANIFEST_PATH} to be offered it again.`,
        ];
  });
}

/** Compared on normalized text, because the append seam and a checkout both rewrite line endings. */
function containsFragment(source: string, fragment: string): boolean {
  return normalize(source).includes(normalize(fragment));
}

function normalize(text: string): string {
  return text.replace(/\r\n?/gu, "\n").trim();
}
