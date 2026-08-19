import { resolve } from "node:path";

import {
  defineCheck,
  type AdapterSharedLinkKind,
  type AppModel,
  type DetectedFinding,
  type Finding,
  type FixPlan,
  type InstructionDocument,
  type ResolvedSharedLink,
  type WorkspaceModel,
} from "@tryaura/aura-sdk";
import { SHARED_INSTRUCTIONS_TEMPLATE } from "@tryaura/content-official";
import { planSharedInstructionLink } from "@tryaura/core";

const READY = "Aura can add the missing link with check --fix.";
const SHARED_INSTRUCTION_GROUP = Object.freeze({
  description: "Create the shared source and connect supported agent applications.",
  id: "checks-core/shared-instructions",
  title: "Complete the shared instruction setup",
});

export const sharedInstructionsCheck = defineCheck({
  defaultSeverity: "error",
  detect(model) {
    const shared = model.sharedInstructions;
    if (shared.problem !== undefined) {
      return [
        {
          details: `Aura could not safely read this path (${shared.problem}) and will not overwrite it.`,
          id: "shared-source",
          locations: [{ path: shared.path }],
          message: "The shared instruction source cannot be read safely.",
        },
      ];
    }
    if (shared.exists && shared.content !== undefined && shared.content.trim().length > 0) {
      return [];
    }
    return [
      {
        id: "shared-source",
        locations: [{ path: shared.path }],
        message: shared.exists
          ? "The shared instruction source is empty."
          : "The shared instruction source is missing.",
      },
    ];
  },
  explain: `A non-empty shared instruction source gives every configured agent application one canonical set of guidance. Without it, application-specific files become independent copies that drift as preferences change.

Re-run the check with \`--fix\` to create the shared source from Aura's starter template. Review the generated ~/agents/AGENTS.md, add personal guidance there, and check again.`,
  findingGroup: SHARED_INSTRUCTION_GROUP,
  fix(_finding, model): FixPlan | undefined {
    const shared = model.sharedInstructions;
    if (shared.problem !== undefined || (shared.content?.trim().length ?? 0) > 0) {
      return undefined;
    }
    return {
      operations: [
        {
          content: SHARED_INSTRUCTIONS_TEMPLATE,
          mode: 0o644,
          path: shared.path,
          type: "write",
        },
      ],
      summary: "Create the shared instruction source.",
    };
  },
  fixability: "auto",
  id: "INS-001",
  scope: "global",
  title: "Shared instructions exist",
});

export const sharedInstructionLinksCheck = defineCheck({
  defaultSeverity: "error",
  detect(model) {
    return model.apps.flatMap((app) => detectMissingLink(app, model));
  },
  explain: `Each detected agent application must load the canonical shared instructions through a mechanism its adapter understands. A missing import, native copy, or symlink leaves that application working from different rules even when the shared source is correct.

Re-run the check with \`--fix\` to add the adapter-supported link without replacing unrelated instructions. Inspect the preview first, apply it, then restart the affected application if it caches instruction files.`,
  findingGroup: SHARED_INSTRUCTION_GROUP,
  fix(finding, model): FixPlan | undefined {
    const app = model.apps.find((candidate) => candidate.adapterId === findingAppId(finding));
    if (app === undefined) {
      return undefined;
    }
    const outcome = planSharedInstructionLink(app, model);
    return "plan" in outcome ? outcome.plan : undefined;
  },
  fixability: "auto",
  id: "INS-002",
  scope: "global",
  title: "Agent applications load shared instructions",
});

function detectMissingLink(app: AppModel, model: WorkspaceModel): readonly DetectedFinding[] {
  // An inventory adapter models files no application owns, so there is nothing to link it to.
  if (app.synthetic === true) {
    return [];
  }
  const shared = app.sharedLink;
  const sharedPath = resolve(model.sharedInstructions.path);
  if (shared !== undefined && linksToShared(app, shared, sharedPath)) {
    return [];
  }

  const outcome = planSharedInstructionLink(app, model);
  const blocked = "blocked" in outcome;
  return [
    {
      details: blocked ? outcome.blocked : READY,
      // A blocked outcome has no plan behind it — an unverifiable version, an undeclared
      // mechanism, a file Aura will not overwrite. `fix` returns nothing for those, so the
      // finding must not carry the check's `auto` fixability into a report that then offers a
      // remediation which never arrives.
      ...(blocked ? { fixability: "manual" as const } : {}),
      id: app.adapterId,
      ...(shared === undefined ? {} : { locations: [{ path: shared.entryPath }] }),
      message: `${app.displayName} does not load the shared instruction source.`,
      metadata: { appId: app.adapterId },
    },
  ];
}

/** Whether the declared entry already carries a link the declared mechanism would have written. */
function linksToShared(app: AppModel, shared: ResolvedSharedLink, sharedPath: string): boolean {
  const entryPath = resolve(shared.entryPath);
  return app.instructionFiles.some(
    (document) =>
      resolve(document.path) === entryPath &&
      document.links.some(
        (link) =>
          link.valid &&
          compatibleLink(shared.kind, link.kind) &&
          resolve(link.targetPath) === sharedPath,
      ),
  );
}

/** Which parsed link kinds each declared mechanism can be satisfied by. */
function compatibleLink(
  declared: AdapterSharedLinkKind,
  found: InstructionDocument["links"][number]["kind"],
): boolean {
  switch (declared) {
    case "symlink": {
      return found === "symlink";
    }
    case "import-line":
    case "native-copy": {
      return found === "import" || found === "native";
    }
  }
}

function findingAppId(finding: Finding): string | undefined {
  const appId = finding.metadata?.["appId"];
  return typeof appId === "string" ? appId : undefined;
}
