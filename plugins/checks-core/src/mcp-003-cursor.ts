import {
  CURSOR_ADAPTER_ID,
  readCursorMcpRuntimeStates,
  readCursorMcpStateUnavailable,
} from "@tryaura/adapter-cursor";
import type { AppModel, DetectedFinding, Finding, GuidedFixChoice } from "@tryaura/aura-sdk";

import { CURSOR_STATE_ACTIONS, type ActionableCursorState } from "./mcp-003-cursor-actions.js";

const CHECK_ID = "MCP-003";

/**
 * Cursor runtime-state findings that are not superseded by a concrete transport failure.
 *
 * A server disabled in `mcp.json` never reaches here: the adapter records it as an unusable entry
 * rather than a server, so it is absent from `app.mcpServers` and the name filter below drops it.
 * The `disabled` state this reports is the other one — enabled in the file, switched off in
 * Cursor's MCP settings, which no file states.
 */
export function cursorMcpStateFindings(
  app: AppModel,
  concretelyFailed: ReadonlySet<string>,
): readonly DetectedFinding[] {
  if (app.adapterId !== CURSOR_ADAPTER_ID) {
    return [];
  }
  const unavailable = readCursorMcpStateUnavailable(app);
  if (unavailable !== undefined) {
    return [unavailableFinding(app, unavailable)];
  }
  const states = readCursorMcpRuntimeStates(app);
  if (states === undefined) {
    return [];
  }

  const configuredNames = new Set(app.mcpServers.map((server) => server.name));
  return Object.entries(states).flatMap(([name, state]) => {
    if (!configuredNames.has(name) || state === "ready") {
      return [];
    }
    if (state === "unknown") {
      return [unknownStateFinding(app, name)];
    }
    return state === "error" && concretelyFailed.has(mcpServerNameKey(app.adapterId, name))
      ? []
      : [cursorStateFinding(app, name, state)];
  });
}

/** Zero-operation guided action for one Cursor-owned runtime-state finding. */
export function cursorMcpStateChoice(finding: Finding): GuidedFixChoice | undefined {
  if (
    finding.checkId !== CHECK_ID ||
    finding.metadata?.["appId"] !== CURSOR_ADAPTER_ID ||
    finding.metadata?.["kind"] !== "cursor-state"
  ) {
    return undefined;
  }
  const name = finding.metadata["serverName"];
  const state = finding.metadata["state"];
  if (typeof name !== "string" || !isActionableState(state)) {
    return undefined;
  }

  const action = CURSOR_STATE_ACTIONS[state];
  return {
    id: action.choiceId,
    label: action.choiceLabel,
    plan: {
      manualSteps: [action.guidance(name), "Run `aura check` again."],
      operations: [],
      summary: action.summary(name),
    },
  };
}

/** Stable identity for the name-level state Cursor reports. */
export function mcpServerNameKey(appId: string, name: string): string {
  return `${appId}\0${name}`;
}

function cursorStateFinding(
  app: AppModel,
  name: string,
  state: ActionableCursorState,
): DetectedFinding {
  const action = CURSOR_STATE_ACTIONS[state];
  return {
    details: action.guidance(name),
    id: `${app.adapterId}:${name}:cursor-${state}`,
    message: action.message(name, app.displayName),
    metadata: {
      appId: app.adapterId,
      kind: "cursor-state",
      serverName: name,
      state,
    },
    // Every one of these is a warning, including a connection error. Cursor reports one for a
    // server that was merely unreachable at the moment it looked, and MCP-003 already refuses to
    // exit non-zero on a fault that may not repeat — see the transient probe note in mcp-003.ts.
    // Nothing here is gated behind `--online`, which makes failing the run on it worse still.
    severity: "warn",
  };
}

/**
 * A configured server whose status line Cursor changed out from under the parser.
 *
 * Reported rather than dropped. The states are read out of a table meant for a terminal, so a
 * format change turns every row `unknown`; passing silently would render that as a clean bill of
 * health for servers nobody actually checked.
 */
function unknownStateFinding(app: AppModel, name: string): DetectedFinding {
  return {
    details: `Run \`cursor-agent mcp list\` to see what ${app.displayName} reports for server ${name}, and check whether server ${name} is approved and enabled in its MCP settings.`,
    id: `${app.adapterId}:${name}:cursor-unknown`,
    message: `MCP server ${name}'s state in ${app.displayName} could not be understood.`,
    metadata: {
      appId: app.adapterId,
      kind: "cursor-state-unreadable",
      serverName: name,
    },
    severity: "info",
  };
}

/** The companion CLI ran and failed. Say so once, rather than reporting every server as fine. */
function unavailableFinding(app: AppModel, reason: "timeout" | "failed"): DetectedFinding {
  const cause = reason === "timeout" ? "did not finish in time" : "exited unsuccessfully";
  return {
    details: `Run \`cursor-agent mcp list\` to see why, then re-run \`aura check\`. Approval and enablement of ${app.displayName}'s MCP servers were not checked; every other MCP check still ran.`,
    id: `${app.adapterId}:cursor-state-unavailable`,
    message: `${app.displayName}'s MCP server states were not read because \`cursor-agent mcp list\` ${cause}.`,
    metadata: {
      appId: app.adapterId,
      kind: "cursor-state-unavailable",
      reason,
    },
    severity: "info",
  };
}

function isActionableState(value: unknown): value is ActionableCursorState {
  return value === "needs-approval" || value === "disabled" || value === "error";
}
