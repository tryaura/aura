import { CLAUDE_CODE_ADAPTER_ID, readClaudePermissionMode } from "@tryaura/adapter-claude-code";
import {
  CODEX_ADAPTER_ID,
  CODEX_SOURCE_IDS,
  readCodexProjectTrust,
  type ProjectTrust,
} from "@tryaura/adapter-codex";
import {
  defineCheck,
  type AppModel,
  type DetectedFinding,
  type Finding,
  type FixPlan,
  type WorkspaceModel,
} from "@tryaura/aura-sdk";

const RESTRICTIVE_MODES = new Set(["plan", "dontAsk"]);

const EXPLAIN = `Claude Code can appear unable to work when its effective default permission mode is plan or dontAsk. Codex skips project-scoped configuration when a project is untrusted, so Aura also reports projects that are not explicitly trusted.

Claude Code: edit the settings file named by the finding and choose default or acceptEdits as appropriate. Codex: after reviewing the repository, edit ~/.codex/config.toml and trust the exact working directory or the primary Git checkout. Codex resolves linked worktrees back to that primary checkout.`;

export const env004 = defineCheck({
  defaultSeverity: "warn",
  detect: (model) => detectConflicts(model),
  explain: EXPLAIN,
  fix: (finding, model) => guidedFix(finding, model),
  fixability: "guided",
  id: "ENV-004",
  scope: "project",
  title: "Agent settings allow the current project to run normally",
});

function detectConflicts(model: WorkspaceModel): readonly DetectedFinding[] {
  if (model.projectRoot === undefined) {
    return [];
  }

  return model.apps.flatMap((app) => {
    if (app.adapterId === CLAUDE_CODE_ADAPTER_ID) {
      return claudeFindings(app);
    }
    if (app.adapterId === CODEX_ADAPTER_ID) {
      return codexFindings(app);
    }
    return [];
  });
}

function claudeFindings(app: AppModel): readonly DetectedFinding[] {
  const effective = readClaudePermissionMode(app);
  if (effective === undefined || !RESTRICTIVE_MODES.has(effective.mode)) {
    return [];
  }

  const path = sourcePath(app, effective.sourceId);
  return [
    {
      details:
        effective.mode === "plan"
          ? "Plan mode prevents source edits and most commands. Choose a normal working mode if this was not intentional."
          : "dontAsk denies tools that were not pre-approved, which can make requests stop without a permission prompt.",
      id: `claude-permission-mode:${effective.mode}`,
      ...(path === undefined ? {} : { locations: [{ path }] }),
      message: `Claude Code starts this project in ${effective.mode} permission mode.`,
      metadata: { appId: app.adapterId, mode: effective.mode, sourceId: effective.sourceId },
    },
  ];
}

function codexFindings(app: AppModel): readonly DetectedFinding[] {
  const trust: ProjectTrust = readCodexProjectTrust(app) ?? "unknown";
  // An unparseable config.toml is already reported by the adapter, naming the file and the fact
  // that Codex ignores all of it. Adding "this project is not trusted" on top would present one
  // broken file as two unrelated problems, and the trust claim would be guesswork besides.
  if (trust === "trusted" || trust === "unreadable") {
    return [];
  }
  const path = sourcePath(app, CODEX_SOURCE_IDS.mcp);
  return [
    {
      details:
        trust === "untrusted"
          ? "Codex explicitly marks this project untrusted and skips its project-scoped configuration."
          : "Codex has no trusted entry for this working directory or its primary Git checkout, so project-scoped configuration may be unavailable until trust is confirmed.",
      id: `codex-project-trust:${trust}`,
      ...(path === undefined ? {} : { locations: [{ path }] }),
      message:
        trust === "untrusted"
          ? "Codex marks this project as untrusted."
          : "Codex does not mark this project as trusted.",
      metadata: { appId: app.adapterId, sourceId: CODEX_SOURCE_IDS.mcp, trust },
    },
  ];
}

function sourcePath(app: AppModel, sourceId: string): string | undefined {
  return app.sourceFiles.find((file) => file.spec.id === sourceId)?.spec.path;
}

function guidedFix(finding: Finding, model: WorkspaceModel): FixPlan | undefined {
  const appId = finding.metadata?.["appId"];
  if (appId === CLAUDE_CODE_ADAPTER_ID) {
    const path = finding.locations?.[0]?.path;
    if (path === undefined) {
      return undefined;
    }
    return {
      manualSteps: [
        `Edit ${path} and set permissions.defaultMode to default or acceptEdits as appropriate.`,
        "Restart Claude Code and run `aura check` again.",
      ],
      operations: [],
      summary: "Change Claude Code's restrictive default permission mode.",
    };
  }
  if (appId === CODEX_ADAPTER_ID && model.projectRoot !== undefined) {
    const trustRoot = model.gitMainWorktreeRoot ?? model.cwd;
    return {
      manualSteps: [
        // A section header rather than a dotted key: a bare `projects."…".trust_level = …` appended
        // to the file lands inside whichever table is open above it, and Codex never sees it.
        `After reviewing the repository, add [projects.${JSON.stringify(trustRoot)}] with trust_level = "trusted" in ~/.codex/config.toml.`,
        "Restart Codex in the project and run `aura check` again.",
      ],
      operations: [],
      summary: "Trust the current project in Codex.",
    };
  }
  return undefined;
}
