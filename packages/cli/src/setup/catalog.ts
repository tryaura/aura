import type { Adapter, AppModel, WorkspaceModel } from "@tryaura/aura-sdk";
import type { SkippedApp } from "@tryaura/core";

/** One registered adapter as the wizard sees it: detected with a full model, or known but absent. */
export type AppCatalogEntry =
  | {
      readonly app: AppModel;
      readonly kind: "detected";
      readonly supportsSkills: boolean;
    }
  | {
      readonly adapterId: string;
      /**
       * What detection looked at, from {@link Adapter.detectionScope}.
       *
       * Absent when the adapter crashed before it could look, so the wizard never says Aura
       * searched somewhere it did not reach.
       */
      readonly detectionScope?: string | undefined;
      readonly displayName: string;
      readonly installHint?: string | undefined;
      readonly kind: "undetected";
      readonly supportsSkills: boolean;
    };

/** The stable adapter id behind either kind of entry. */
export function catalogEntryId(entry: AppCatalogEntry): string {
  return entry.kind === "detected" ? entry.app.adapterId : entry.adapterId;
}

/** The human-readable application name behind either kind of entry. */
export function catalogEntryName(entry: AppCatalogEntry): string {
  return entry.kind === "detected" ? entry.app.displayName : entry.displayName;
}

/**
 * Every registered adapter in registry order, joined against the scan.
 *
 * `model.apps` only carries applications whose executable was found; the catalog re-adds the rest
 * from the registry so the wizard can offer them — selecting one queues install instructions
 * instead of failing. Inventory adapters report themselves installed so core reads their paths;
 * offering one here would ask the user to manage an application that does not exist.
 *
 * `skipped` separates the rest into applications that were looked for and not found and adapters
 * that crashed before looking, which the wizard tells apart because only the first kind can say
 * where Aura searched.
 */
export function buildAppCatalog(
  adapters: readonly Adapter[],
  model: WorkspaceModel,
  skipped: readonly SkippedApp[],
): readonly AppCatalogEntry[] {
  const probed = new Set(skipped.map((app) => app.adapterId));
  return Object.freeze(
    adapters
      .filter((adapter) => adapter.synthetic !== true)
      .map((adapter): AppCatalogEntry => {
        const supportsSkills = adapter.capabilities?.skills !== undefined;
        const app = model.apps.find((candidate) => candidate.adapterId === adapter.id);
        if (app !== undefined) {
          return { app, kind: "detected", supportsSkills };
        }
        return {
          adapterId: adapter.id,
          detectionScope: probed.has(adapter.id) ? adapter.detectionScope : undefined,
          displayName: adapter.displayName,
          installHint: adapter.installHint,
          kind: "undetected",
          supportsSkills,
        };
      }),
  );
}
