import type { Adapter, AppModel, WorkspaceModel } from "@tryaura/aura-sdk";

/** One registered adapter as the wizard sees it: detected with a full model, or known but absent. */
export type AppCatalogEntry =
  | {
      readonly app: AppModel;
      readonly kind: "detected";
    }
  | {
      readonly adapterId: string;
      readonly displayName: string;
      readonly installHint?: string | undefined;
      readonly kind: "undetected";
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
 */
export function buildAppCatalog(
  adapters: readonly Adapter[],
  model: WorkspaceModel,
): readonly AppCatalogEntry[] {
  return Object.freeze(
    adapters
      .filter((adapter) => adapter.synthetic !== true)
      .map((adapter): AppCatalogEntry => {
        const app = model.apps.find((candidate) => candidate.adapterId === adapter.id);
        if (app !== undefined) {
          return { app, kind: "detected" };
        }
        return {
          adapterId: adapter.id,
          displayName: adapter.displayName,
          installHint: adapter.installHint,
          kind: "undetected",
        };
      }),
  );
}
