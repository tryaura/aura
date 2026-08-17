import { CLAUDE_CODE_ADAPTER_ID } from "@tryaura/adapter-claude-code";
import { CODEX_ADAPTER_ID } from "@tryaura/adapter-codex";
import { defineCheck } from "@tryaura/aura-sdk";

const EXPLAIN = `Aura uses each application's non-interactive status command and reads only its exit code. It never starts a login flow while checking authentication, and applications without a safe status probe are left unknown rather than guessed.

Claude Code: run \`claude auth login\`. Codex: run \`codex login\`. Cursor does not expose a safe credential-status probe, so Aura does not report Cursor authentication.`;

export const env002 = defineCheck({
  defaultSeverity: "error",
  detect: (model) =>
    model.apps.flatMap((app) =>
      app.synthetic !== true && app.detection.authenticated === false
        ? [
            {
              details: authenticationHint(app.adapterId, app.displayName),
              id: `unauthenticated:${app.adapterId}`,
              message: `${app.displayName} is installed but not authenticated.`,
              metadata: { appId: app.adapterId },
            },
          ]
        : [],
    ),
  explain: EXPLAIN,
  fixability: "manual",
  id: "ENV-002",
  scope: "global",
  title: "Agent applications are authenticated",
});

function authenticationHint(appId: string, displayName: string): string {
  switch (appId) {
    case CLAUDE_CODE_ADAPTER_ID: {
      return "Run `claude auth login`, complete authentication, then run `aura check` again.";
    }
    case CODEX_ADAPTER_ID: {
      return "Run `codex login`, complete authentication, then run `aura check` again.";
    }
    default: {
      return `Open ${displayName}, sign in, then run \`aura check\` again.`;
    }
  }
}
