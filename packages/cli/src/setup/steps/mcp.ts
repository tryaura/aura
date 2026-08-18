import type { AuraManifestMcpServer } from "@tryaura/aura-sdk";

import { safe } from "../../safe-text.js";
import { catalogEntryId } from "../catalog.js";
import { managedAppIdList } from "../managed-apps.js";
import { mcpCatalogEntryName, type McpSetupCatalogEntry } from "../mcp-catalog.js";
import { SETUP_ABORTED, SETUP_BACK, type SetupStep, type SetupStepContext } from "../types.js";
import {
  selectedValues,
  type WizardIo,
  type WizardOption,
  type WizardQuestion,
} from "../wizard-types.js";
import { editCustomTransport } from "./mcp-custom.js";
import { configureMcpSelections } from "./mcp-entry.js";
import type { McpStepControl, WorkingMcpEntry } from "./mcp-step-types.js";

const ADD_CUSTOM = "mcp:add-custom";

/** Selects catalog and custom MCP servers, then captures their target name, scope, and apps. */
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
  title: "MCP servers",
};

// fallow-ignore-next-line complexity -- custom additions intentionally return to the same picker.
async function gatherMcp(context: SetupStepContext, io: WizardIo) {
  const entries = workingEntries(context);
  if (entries.length === 0 && context.revisited !== true) {
    io.note("No MCP servers are configured or available from installed plugins.");
  }
  if (!hasManagedMcpApp(context) && entries.every((entry) => entry.existing === undefined)) {
    io.note("No detected, managed application can receive MCP configuration.");
    return { ...context.selections, mcp: { servers: [] } };
  }

  let selectedKeys = initialKeys(entries, context.interactive);
  const overriddenRequiredIds = new Set(context.selections.mcp?.overriddenRequiredIds ?? []);
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
        scope: "global",
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

function workingEntries(context: SetupStepContext): WorkingMcpEntry[] {
  const previous = context.selections.mcp?.servers;
  const entries = context.mcpCatalog.entries.map((entry): WorkingMcpEntry => ({
    ...entry,
    selectedServer: previous?.find((server) => matchesEntry(server, entry)) ?? entry.existing,
  }));
  for (const server of previous ?? []) {
    if (entries.some((entry) => entry.selectedServer === server || matchesEntry(server, entry))) {
      continue;
    }
    entries.push({
      existing: server,
      key: nextCustomKey(entries),
      required: false,
      selectedServer: server,
    });
  }
  return entries;
}

function matchesEntry(server: AuraManifestMcpServer, entry: McpSetupCatalogEntry): boolean {
  const existing = entry.existing;
  if (existing !== undefined) {
    return (
      existing.catalogId === server.catalogId &&
      existing.name === server.name &&
      existing.scope === server.scope
    );
  }
  return entry.catalog?.id === server.catalogId;
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
function initialKeys(entries: readonly WorkingMcpEntry[], interactive: boolean): Set<string> {
  return new Set(
    entries
      .filter((entry) => entry.selectedServer !== undefined || (entry.required && interactive))
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
      `Override the team preset for this run and omit ${missingRequired.map(safe).join(", ")}?`,
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
  return missing;
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
  const configured = entry.selectedServer !== undefined || entry.existing !== undefined;
  const tags = [
    ...(entry.required ? ["preset required"] : []),
    ...(configured ? [entry.catalog === undefined ? "custom" : "configured"] : []),
  ];
  const suffix = tags.length === 0 ? "" : ` (${tags.join(", ")})`;
  const provenance =
    entry.sourceName === undefined ? "Custom server" : `Plugin: ${entry.sourceName}`;
  return {
    description: provenance,
    label: `${safe(mcpCatalogEntryName(entry))}${suffix}`,
    value: entry.key,
  };
}

function nextCustomKey(entries: readonly WorkingMcpEntry[]): string {
  let index = entries.length;
  while (entries.some((entry) => entry.key === `custom:${String(index)}`)) {
    index += 1;
  }
  return `custom:${String(index)}`;
}

/**
 * A default name no other row has taken.
 *
 * Two servers cannot share one name in one application and scope — the manifest refuses to record
 * it — so seeding every custom server with `custom` would turn "add two, accept the defaults" into
 * a plan the manifest declines to hold.
 */
function nextCustomName(entries: readonly WorkingMcpEntry[]): string {
  const taken = new Set(
    entries.flatMap((entry) => {
      const name = entry.selectedServer?.name ?? entry.existing?.name;
      return name === undefined ? [] : [name];
    }),
  );
  if (!taken.has("custom")) {
    return "custom";
  }
  let index = 2;
  while (taken.has(`custom-${String(index)}`)) {
    index += 1;
  }
  return `custom-${String(index)}`;
}

function hasManagedMcpApp(context: SetupStepContext): boolean {
  const managed = new Set(managedAppIdList(context));
  return context.appCatalog.some(
    (entry) => entry.kind === "detected" && entry.supportsMcp && managed.has(catalogEntryId(entry)),
  );
}
