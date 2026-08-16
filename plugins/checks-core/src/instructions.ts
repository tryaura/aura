import { resolve } from "node:path";

import {
  defineCheck,
  type AppModel,
  type DetectedFinding,
  type Finding,
  type FixPlan,
  type InstructionDocument,
  type WorkspaceModel,
} from "@tryaura/aura-sdk";
import { SHARED_INSTRUCTIONS_TEMPLATE } from "@tryaura/content-official";
import { planSharedInstructionLink } from "@tryaura/core";

const READY = "Aura can add the missing link with check --fix.";

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
  const sharedPath = resolve(model.sharedInstructions.path);
  const valid = app.instructionFiles.some((document) =>
    document.links.some(
      (link) =>
        link.valid && compatibleLink(app, link.kind) && resolve(link.targetPath) === sharedPath,
    ),
  );
  if (valid) {
    return [];
  }

  const outcome = planSharedInstructionLink(app, model);
  const entry = app.sharedLink?.entryPath;
  return [
    {
      details: "blocked" in outcome ? outcome.blocked : READY,
      id: app.adapterId,
      ...(entry === undefined ? {} : { locations: [{ path: entry }] }),
      message: `${app.displayName} does not load the shared instruction source.`,
      metadata: { appId: app.adapterId },
    },
  ];
}

function compatibleLink(
  app: AppModel,
  kind: InstructionDocument["links"][number]["kind"],
): boolean {
  switch (app.sharedLink?.kind) {
    case "symlink": {
      return kind === "symlink";
    }
    case "import-line":
    case "native-copy": {
      return kind === "import" || kind === "native";
    }
    case undefined: {
      return true;
    }
  }
}

function findingAppId(finding: Finding): string | undefined {
  const appId = finding.metadata?.["appId"];
  return typeof appId === "string" ? appId : undefined;
}
