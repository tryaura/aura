import { defineCheck, type AppModel } from "@tryaura/aura-sdk";

const EXPLAIN = `Aura verifies the installed version of every detected agent application before relying on its configuration format. An unknown or unsupported version can make findings incomplete, so fixes for unsupported applications must be treated as report-only.

Claude Code: run \`claude update\`. Codex: run \`npm install -g @openai/codex@latest\` or update it with your package manager. Cursor: use Help > Check for Updates. Then run \`aura check\` again.`;

export const env001 = defineCheck({
  defaultSeverity: "warn",
  detect: (model) =>
    model.apps.flatMap((app) => {
      if (app.synthetic === true || app.support.status === "supported") {
        return [];
      }

      return [
        {
          details: detailFor(app),
          id: `${app.support.status}-version:${app.adapterId}`,
          message:
            app.support.status === "unknown"
              ? `${app.displayName} is installed, but its version could not be determined.`
              : `${app.displayName} ${app.support.version ?? "unknown"} is outside Aura's supported range ${app.support.supportedRange}.`,
          metadata: {
            appId: app.adapterId,
            reportOnly: app.support.status === "unsupported",
            supportedRange: app.support.supportedRange,
          },
        },
      ];
    }),
  explain: EXPLAIN,
  fixability: "manual",
  id: "ENV-001",
  scope: "global",
  title: "Agent applications use supported versions",
});

function detailFor(app: AppModel): string {
  const hint = app.installHint ?? `Update or reinstall ${app.displayName}, then run Aura again.`;
  return app.support.status === "unsupported"
    ? `${hint} Aura will report what it can, but fixes are downgraded to report-only for this version.`
    : hint;
}
