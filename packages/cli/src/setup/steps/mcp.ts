import type { AuraManifestMcpServer } from "@tryaura/aura-sdk";

import { safe } from "../../safe-text.js";
import { catalogEntryId } from "../catalog.js";
import { managedAppIdList } from "../managed-apps.js";
import { mcpCatalogEntryName } from "../mcp-catalog.js";
import {
  SETUP_ABORTED,
  SETUP_BACK,
  type SetupStep,
  type SetupStepContext,
  type SetupStepOutcome,
} from "../types.js";
import {
  selectedValues,
  type WizardIo,
  type WizardOption,
  type WizardQuestion,
} from "../wizard-types.js";
import { editCustomTransport } from "./mcp-custom.js";
import { configureMcpSelections } from "./mcp-entry.js";
import type { McpStepControl, WorkingMcpEntry } from "./mcp-step-types.js";
import { nextCustomKey, nextCustomName, workingEntries } from "./mcp-working-entries.js";

const ADD_CUSTOM = "mcp:add-custom";

export const mcpStep: SetupStep = {
  addKind: "mcp",
  compactTitle: "MCP",
  gather: gatherMcp,
  id: "mcp",
  prerequisites: [
    {
      id: "apps",
      isSatisfied: (context) => context.manifest.status === "ready",
      title: "an Aura manifest",
    },
    {
      id: "apps",
      isSatisfied: (context) =>
        context.manifest.status === "ready" &&
        (hasManagedMcpApp(context) || context.manifest.value.mcpServers.length > 0),
      title: "a managed application that supports MCP configuration",
    },
  ],
  telemetryCategory: "mcpServers",
  title: "MCP servers",
};

// fallow-ignore-next-line complexity -- custom additions intentionally return to the same picker.
async function gatherMcp(context: SetupStepContext, io: WizardIo): Promise<SetupStepOutcome> {
  const entries = workingEntries(context);
  if (entries.length === 0 && context.revisited !== true) {
    io.note("No MCP servers are configured or available from installed plugins.");
  }
  if (!hasManagedMcpApp(context) && entries.every((entry) => entry.existing === undefined)) {
    io.note("No detected, managed application can receive MCP configuration.");
    // The empty slice is for the planner, which reads an absent one as "keep what is configured".
    return { selections: { ...context.selections, mcp: { servers: [] } }, unoffered: true };
  }

  const overriddenRequiredIds = new Set(
    context.selections.mcp?.overriddenRequiredIds ??
      (context.manifest.status === "ready"
        ? (context.manifest.value.overrides?.requiredMcpServers ?? [])
        : []),
  );
  let selectedKeys = initialKeys(entries, context.interactive, overriddenRequiredIds);
  for (;;) {
    const picked = await pickServers(context, entries, selectedKeys, overriddenRequiredIds, io);
    if (picked === SETUP_ABORTED || picked === SETUP_BACK) {
      return picked;
    }
    selectedKeys = picked;

    if (selectedKeys.has(ADD_CUSTOM)) {
      selectedKeys.delete(ADD_CUSTOM);
      const transport = await editCustomTransport(undefined, io, context);
      if (transport === SETUP_ABORTED) {
        return transport;
      }
      if (transport === SETUP_BACK) {
        continue;
      }
      const key = nextCustomKey(entries);
      const server: AuraManifestMcpServer = {
        apps: [],
        name: nextCustomName(entries),
        transport,
      };
      entries.push({
        customTransportIsFresh: true,
        existing: server,
        key,
        required: false,
        selectedServer: server,
      });
      selectedKeys.add(key);
      continue;
    }

    const configured = await configureMcpSelections(context, entries, selectedKeys, io);
    if (configured === SETUP_ABORTED) {
      return configured;
    }
    if (configured === SETUP_BACK) {
      continue;
    }
    return {
      ...context.selections,
      mcp: { overriddenRequiredIds: [...overriddenRequiredIds], servers: configured },
    };
  }
}

/**
 * Pre-checks what this run may propose, which is not the same as what the preset asks for.
 *
 * A server already recorded in the manifest is re-applied either way. A preset-required one that
 * is not recorded yet is pre-checked only for a person who can see the row: an MCP server is a
 * remote endpoint handed a credential, and `--yes` accepting a repository's `.aura/preset.json` on
 * sight is exactly the first-configuration the skills step refuses for the same reason. Left
 * unchecked the requirement becomes a blocker naming the interactive run, never a silent skip.
 */
function initialKeys(
  entries: readonly WorkingMcpEntry[],
  interactive: boolean,
  overriddenRequiredIds: ReadonlySet<string>,
): Set<string> {
  return new Set(
    entries
      .filter(
        (entry) =>
          entry.selectedServer !== undefined ||
          (entry.required &&
            interactive &&
            (entry.catalog === undefined || !overriddenRequiredIds.has(entry.catalog.id))),
      )
      .map((entry) => entry.key),
  );
}

async function pickServers(
  context: SetupStepContext,
  entries: readonly WorkingMcpEntry[],
  initial: ReadonlySet<string>,
  overriddenRequiredIds: Set<string>,
  io: WizardIo,
): Promise<Set<string> | McpStepControl> {
  const question: WizardQuestion = {
    id: "mcp-servers",
    initial: [...initial],
    kind: "multiselect",
    label: "Servers",
    options: [
      ...entries.map(serverOption),
      {
        description: "Enter a stdio command or remote HTTP definition without credential values.",
        label: "Add a custom server…",
        value: ADD_CUSTOM,
      },
    ],
    prompt: "Which MCP servers should Aura configure?",
  };

  for (;;) {
    const result = await io.ask([question], context.flow);
    if (result === "aborted") {
      return SETUP_ABORTED;
    }
    if (result === "back") {
      return SETUP_BACK;
    }
    const selected = new Set(selectedValues(result["mcp-servers"]));
    const missingRequired = reconcileRequiredOverrides(entries, selected, overriddenRequiredIds);
    // Only a person can override a team preset. A run answering its own questions leaves the
    // requirement unmet, which the planner reports as a blocker naming what to do about it.
    if (missingRequired.length === 0 || !context.interactive) {
      return selected;
    }
    const confirmation = await io.confirm(
      `Override the team preset on this machine and omit ${missingRequired.map(safe).join(", ")}?`,
    );
    if (confirmation === "accepted") {
      for (const id of missingRequired) {
        overriddenRequiredIds.add(id);
      }
      return selected;
    }
    if (confirmation === "aborted") {
      return SETUP_ABORTED;
    }
  }
}

function reconcileRequiredOverrides(
  entries: readonly WorkingMcpEntry[],
  selected: ReadonlySet<string>,
  overriddenRequiredIds: Set<string>,
): readonly string[] {
  const requiredIds = requiredCatalogIds(entries);
  const missing = requiredIds.filter(
    (id) => !entries.some((entry) => entry.catalog?.id === id && selected.has(entry.key)),
  );
  for (const id of requiredIds) {
    if (!missing.includes(id)) {
      overriddenRequiredIds.delete(id);
    }
  }
  return missing.filter((id) => !overriddenRequiredIds.has(id));
}

function requiredCatalogIds(entries: readonly WorkingMcpEntry[]): readonly string[] {
  return [
    ...new Set(
      entries.flatMap((entry) =>
        entry.required && entry.catalog !== undefined ? [entry.catalog.id] : [],
      ),
    ),
  ];
}

function serverOption(entry: WorkingMcpEntry): WizardOption {
  const tags = serverTags(entry);
  const suffix = tags.length === 0 ? "" : ` (${tags.join(", ")})`;
  return {
    description: serverProvenance(entry),
    label: `${safe(mcpCatalogEntryName(entry))}${suffix}`,
    value: entry.key,
  };
}

/** What the run knows about a row: who selected it, whether it is required or configured. */
function serverTags(entry: WorkingMcpEntry): readonly string[] {
  const configured = entry.selectedServer !== undefined || entry.existing !== undefined;
  const origin = entry.repo === true ? "from repo" : "from preset";
  return [
    ...(entry.required ? [origin, "required"] : entry.repo === true ? [origin] : []),
    ...(configured ? [entry.catalog === undefined ? "custom" : "configured"] : []),
  ];
}

function serverProvenance(entry: WorkingMcpEntry): string {
  if (entry.repo === true) {
    return "Repository: .aura/preset.json";
  }
  return entry.sourceName === undefined ? "Custom server" : `Plugin: ${entry.sourceName}`;
}

function hasManagedMcpApp(context: SetupStepContext): boolean {
  const managed = new Set(managedAppIdList(context));
  return context.appCatalog.some(
    (entry) => entry.kind === "detected" && entry.supportsMcp && managed.has(catalogEntryId(entry)),
  );
}
