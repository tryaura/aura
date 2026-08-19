import { resolve } from "node:path";

import type { FileOperation, Scope } from "@tryaura/aura-sdk";
import { planSharedInstructionLink } from "@tryaura/core";

import { managedAppIdList } from "./managed-apps.js";
import type { InstructionScopeSelection, SetupStepContext } from "./types.js";

/** Where each archived source is headed, keyed by canonical path. */
export type ArchivedSources = ReadonlyMap<
  string,
  { readonly relativePath: string; readonly scope: Scope }
>;

/** Wires every managed application to the scope targets that survived planning. */
export function planLinks(
  context: SetupStepContext,
  scopeSelections: readonly InstructionScopeSelection[],
  archived: ArchivedSources,
  ownership: Map<string, string[]>,
  manualSteps: string[],
): FileOperation[] {
  const managedIds = new Set(managedAppIdList(context));
  const operations: FileOperation[] = [];
  for (const app of context.model.apps) {
    if (app.synthetic === true || !managedIds.has(app.adapterId)) {
      continue;
    }
    operations.push(
      ...planAppLinks(context, app, scopeSelections, archived, ownership, manualSteps),
    );
  }
  return operations;
}

function planAppLinks(
  context: SetupStepContext,
  app: SetupStepContext["model"]["apps"][number],
  scopeSelections: readonly InstructionScopeSelection[],
  archived: ArchivedSources,
  ownership: Map<string, string[]>,
  manualSteps: string[],
): FileOperation[] {
  return scopeSelections.flatMap((selection) => {
    const link = selection.scope === "global" ? app.sharedLink : app.projectSharedLink;
    if (link === undefined) {
      return [];
    }
    // Resolved on both sides: `archived` is keyed by canonical path, and a miss here would plan a
    // write against pre-archival content on a path an archive already claims — two operations on
    // one path, which the kernel rejects as a conflict rather than falling back to anything.
    const outcome = planSharedInstructionLink(app, context.model, {
      link,
      ...(archived.has(resolve(link.entryPath)) ? { sourceContent: "" } : {}),
      symlinkTarget: selection.targetPath,
    });
    if ("blocked" in outcome) {
      manualSteps.push(`Aura could not wire ${link.entryPath}: ${outcome.blocked}`);
      return [];
    }
    manualSteps.push(...(outcome.plan.manualSteps ?? []));
    const files = ownership.get(app.adapterId) ?? [];
    files.push(link.entryPath);
    ownership.set(app.adapterId, files);
    return [...outcome.plan.operations];
  });
}
