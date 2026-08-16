import { resolve } from "node:path";

import {
  defineCheck,
  type AdapterFileStatus,
  type AppModel,
  type DetectedFinding,
  type Finding,
  type FixPlan,
  type InstructionDocument,
  type ResolvedSharedLink,
  type WorkspaceModel,
} from "@tryaura/aura-sdk";
import { SHARED_INSTRUCTIONS_TEMPLATE } from "@tryaura/content-official";
import { reconcileManagedBlock } from "@tryaura/core";

const SHARED_LINK_SNIPPET_ID = "shared-instructions";
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
  explain:
    "A non-empty shared instruction source gives every configured agent application one canonical set of guidance.",
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
  explain:
    "Each detected agent application must load the canonical shared instructions through a mechanism its adapter understands.",
  fix(finding, model): FixPlan | undefined {
    const app = model.apps.find((candidate) => candidate.adapterId === findingAppId(finding));
    if (app === undefined) {
      return undefined;
    }
    const outcome = resolveLink(app, model);
    return "plan" in outcome ? outcome.plan : undefined;
  },
  fixability: "auto",
  id: "INS-002",
  scope: "global",
  title: "Agent applications load shared instructions",
});

/**
 * Either the remediation for one application, or why there isn't one.
 *
 * Both answers come from {@link resolveLink}, so what the finding tells the user and what `--fix`
 * actually does cannot drift apart: a finding never promises a fix the plan will not produce.
 */
type LinkOutcome = { readonly blocked: string } | { readonly plan: FixPlan };

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

  const outcome = resolveLink(app, model);
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

/** Decides what Aura can do for one application, and says so in the same breath. */
function resolveLink(app: AppModel, model: WorkspaceModel): LinkOutcome {
  const link = app.sharedLink;
  if (link === undefined) {
    return { blocked: "This adapter does not declare an automatic shared-link mechanism." };
  }

  const status = entryStatus(app);
  const refusal = refuseBefore(app, status);
  if (refusal !== undefined) {
    return { blocked: refusal };
  }

  switch (link.kind) {
    case "import-line": {
      return importLineOutcome(app, link, status);
    }
    case "native-copy": {
      return nativeCopyOutcome(app, link, status);
    }
    case "symlink": {
      return symlinkOutcome(app, link, model, status);
    }
  }
}

/** The reasons Aura declines before the mechanism matters, or nothing when none of them apply. */
function refuseBefore(app: AppModel, status: AdapterFileStatus | undefined): string | undefined {
  if (app.support.status !== "supported") {
    return "Aura does not modify instruction files for an application version it cannot verify.";
  }
  if (status?.problem !== undefined) {
    return `Aura could not safely read the instruction entry (${status.problem}) and will not overwrite it.`;
  }
  return status?.pathKind === "directory"
    ? "The instruction entry is a directory and cannot be replaced automatically."
    : undefined;
}

function importLineOutcome(
  app: AppModel,
  link: ResolvedSharedLink,
  status: AdapterFileStatus | undefined,
): LinkOutcome {
  const source = instructionEntry(app, link.entryPath);
  if (status?.exists === true && source === undefined) {
    return {
      blocked: `Something is at ${link.entryPath} that the adapter could not read as an instruction file, so Aura will not replace it. Check whether it is a broken symbolic link.`,
    };
  }

  const reconciled = reconcileManagedBlock(source?.content ?? "", [
    { content: link.content ?? "", id: SHARED_LINK_SNIPPET_ID },
  ]);
  if (reconciled.status === "invalid") {
    return {
      blocked: `The Aura-managed block in ${link.entryPath} is malformed, so Aura will not rewrite the file. Repair or delete the block and run check --fix again.`,
    };
  }
  return { plan: writePlan(app, link, reconciled.content) };
}

function nativeCopyOutcome(
  app: AppModel,
  link: ResolvedSharedLink,
  status: AdapterFileStatus | undefined,
): LinkOutcome {
  const source = instructionEntry(app, link.entryPath);
  if (status?.exists === true && source?.content !== link.content) {
    return {
      blocked:
        "The Aura wrapper path contains different content, so it is treated as user-owned and preserved. Persistent keep-yours state is tracked by AURA-24.",
    };
  }
  return { plan: writePlan(app, link, link.content ?? "") };
}

function symlinkOutcome(
  app: AppModel,
  link: ResolvedSharedLink,
  model: WorkspaceModel,
  status: AdapterFileStatus | undefined,
): LinkOutcome {
  if (status?.exists === true && status.pathKind !== "symlink") {
    return {
      blocked:
        "The existing file is user-owned. Consolidate its content into ~/agents/AGENTS.md before replacing it with a symlink; guided setup is tracked by AURA-27.",
    };
  }
  return {
    plan: {
      operations: [
        {
          path: link.entryPath,
          target: model.sharedInstructions.path,
          type: "symlink",
        },
      ],
      summary: `Link ${app.displayName} to the shared instruction source.`,
    },
  };
}

/**
 * Writes the entry, warning when its content only makes sense on this machine.
 *
 * A project-scoped entry has to name the shared source by absolute path, so it carries the user's
 * home directory into a file that lives in a repository. Committing that leaks a username and
 * resolves to nothing for everyone else, so the plan says so rather than leaving it to be found.
 */
function writePlan(app: AppModel, link: ResolvedSharedLink, content: string): FixPlan {
  return {
    ...(link.scope === "project"
      ? {
          manualSteps: [
            `${link.entryPath} points at the shared source by absolute path, which is specific to this machine and this user. Keep it out of version control — add it to .gitignore or .git/info/exclude.`,
          ],
        }
      : {}),
    operations: [{ content, mode: 0o644, path: link.entryPath, type: "write" }],
    summary: `Link ${app.displayName} to the shared instruction source.`,
  };
}

function instructionEntry(app: AppModel, path: string): InstructionDocument | undefined {
  return app.instructionFiles.find((document) => resolve(document.path) === resolve(path));
}

function entryStatus(app: AppModel): AdapterFileStatus | undefined {
  const entryPath = app.sharedLink?.entryPath;
  return entryPath === undefined
    ? undefined
    : app.sourceFiles.find((file) => resolve(file.spec.path) === resolve(entryPath));
}

function findingAppId(finding: Finding): string | undefined {
  const appId = finding.metadata?.["appId"];
  return typeof appId === "string" ? appId : undefined;
}
