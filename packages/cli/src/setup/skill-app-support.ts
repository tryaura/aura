import { catalogEntryId, catalogEntryName } from "./catalog.js";
import { managedAppIdList } from "./managed-apps.js";
import type { SetupStepContext } from "./types.js";

/**
 * What this build can say about one managed application and Agent Skills.
 *
 * `"unknown"` is not `"unsupported"`: the manifest keeps applications this build does not ship
 * (see `desiredApps` in `planner.ts`), so their capabilities are unreadable rather than absent.
 */
type SkillSupport = "supported" | "unknown" | "unsupported";

/** One managed application's cell in the skills support matrix. */
export interface ManagedSkillApp {
  readonly displayName: string;
  readonly id: string;
  readonly support: SkillSupport;
}

/** Managed apps in registry order, followed by manifest-only adapter ids this build cannot name. */
export function managedSkillApps(context: SetupStepContext): readonly ManagedSkillApp[] {
  const selected = managedAppIdList(context);
  const managed = new Set(selected);
  const covered = new Set<string>();
  const apps = context.appCatalog.flatMap((entry): readonly ManagedSkillApp[] => {
    const id = catalogEntryId(entry);
    if (!managed.has(id)) {
      return [];
    }
    covered.add(id);
    return [
      {
        displayName: catalogEntryName(entry),
        id,
        support: entry.supportsSkills ? "supported" : "unsupported",
      },
    ];
  });
  return [
    ...apps,
    ...selected
      .filter((id) => !covered.has(id))
      .map((id): ManagedSkillApp => ({ displayName: id, id, support: "unknown" })),
  ];
}

/** True when at least one managed application is known to load Agent Skills. */
export function hasSkillsHome(apps: readonly ManagedSkillApp[]): boolean {
  return apps.some((app) => app.support === "supported");
}

/**
 * The opening checkboxes, plus the picks a changed Apps answer forces the step to hold back.
 *
 * Held-back picks are the security-relevant half: a selection made while a supporting application
 * was chosen must not ride forward into the plan once that application is gone. Recorded skills
 * stay checked so the guarded uninstall path survives.
 */
export function initialSkillSelection(
  previous: readonly string[],
  recorded: ReadonlySet<string>,
  apps: readonly ManagedSkillApp[],
): { readonly heldBack: readonly string[]; readonly selected: readonly string[] } {
  if (hasSkillsHome(apps)) {
    return { heldBack: [], selected: previous };
  }
  return {
    heldBack: previous.filter((identity) => !recorded.has(identity)),
    selected: previous.filter((identity) => recorded.has(identity)),
  };
}

/** One line naming every managed application and what it can do with skills. */
export function skillSupportMatrix(apps: readonly ManagedSkillApp[]): string {
  if (apps.length === 0) {
    return "Apps: none";
  }
  return `Apps: ${apps.map(supportCell).join(" · ")}`;
}

function supportCell(app: ManagedSkillApp): string {
  if (app.support === "supported") {
    return `✓ ${app.displayName}`;
  }
  return app.support === "unknown"
    ? `? ${app.displayName} (not in this build)`
    : `— ${app.displayName}`;
}
