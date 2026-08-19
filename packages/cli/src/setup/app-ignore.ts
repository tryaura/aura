import type { AuraManifest } from "@tryaura/aura-sdk";

import { catalogEntryId, type AppCatalogEntry } from "./catalog.js";
import type { SetupSelections } from "./types.js";

/** Applies this setup pass's explicit ignored-app decisions while preserving unknown adapters. */
export function withIgnoredAppSelections(
  manifest: AuraManifest,
  previous: AuraManifest,
  apps: NonNullable<SetupSelections["apps"]>,
  appCatalog: readonly AppCatalogEntry[],
): AuraManifest {
  const available = new Set(appCatalog.map(catalogEntryId));
  const managed = new Set(apps.managed);
  const selectedIgnored = new Set(apps.ignored ?? []);
  const ignoredApps = [
    ...new Set([
      ...(previous.ignoredApps ?? []).filter((id) => !available.has(id)),
      ...appCatalog.map(catalogEntryId).filter((id) => !managed.has(id) && selectedIgnored.has(id)),
    ]),
  ];
  const { ignoredApps: _previous, ...rest } = manifest;
  return ignoredApps.length === 0 ? rest : { ...rest, ignoredApps };
}
