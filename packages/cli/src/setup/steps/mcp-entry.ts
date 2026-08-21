import { mcpServerNameProblem, type AuraManifestMcpServer } from "@tryaura/aura-sdk";

import { safe } from "../../safe-text.js";
import { catalogEntryId, catalogEntryName, type AppCatalogEntry } from "../catalog.js";
import { managedAppIdList } from "../managed-apps.js";
import { SETUP_ABORTED, SETUP_BACK, type SetupStepContext } from "../types.js";
import { selectedValues, type WizardIo, type WizardOption } from "../wizard-types.js";
import { answerText, editCustomTransport, textQuestion } from "./mcp-custom.js";
import type { McpStepControl, WorkingMcpEntry } from "./mcp-step-types.js";

/**
 * Walks the picked rows one form at a time, recording each answer on the row it belongs to.
 *
 * Writing back into `entries` is what makes ← survivable: a later form resolving `"back"` returns
 * the whole batch to the picker, and re-entry re-seeds every row from what this pass already
 * answered instead of from the run's opening state. Clearing `customTransportIsFresh` at the same
 * point is the other half — a transport is unaskable only between adding it and configuring it.
 */
export async function configureMcpSelections(
  context: SetupStepContext,
  entries: WorkingMcpEntry[],
  selectedKeys: ReadonlySet<string>,
  io: WizardIo,
): Promise<readonly AuraManifestMcpServer[] | McpStepControl> {
  const servers: AuraManifestMcpServer[] = [];
  for (const [index, entry] of entries.entries()) {
    if (!selectedKeys.has(entry.key)) {
      continue;
    }
    const configured = await configureEntry(context, entry, servers, io);
    // Consumed by the visit, not by its outcome: the flag suppresses the transport form only
    // between adding a custom server and reaching its first form, so a return trip through the
    // picker can correct a command that was typed wrong.
    const visited: WorkingMcpEntry = { ...entry, customTransportIsFresh: false };
    entries[index] = visited;
    if (configured === SETUP_ABORTED || configured === SETUP_BACK) {
      return configured;
    }
    if (configured !== undefined) {
      entries[index] = { ...visited, selectedServer: configured };
      servers.push(configured);
    }
  }
  return Object.freeze(servers);
}

// fallow-ignore-next-line complexity -- validates and reseeds the three server fields as one form.
async function configureEntry(
  context: SetupStepContext,
  entry: WorkingMcpEntry,
  taken: readonly AuraManifestMcpServer[],
  io: WizardIo,
): Promise<AuraManifestMcpServer | McpStepControl | undefined> {
  const seed = entry.selectedServer ?? entry.existing;
  const catalog = entry.catalog?.manifest;
  let transport = seed?.transport ?? catalog?.transportTemplate;
  if (catalog === undefined && entry.customTransportIsFresh !== true) {
    const custom = await editCustomTransport(transport, io, context);
    if (custom === SETUP_ABORTED || custom === SETUP_BACK) {
      return custom;
    }
    transport = custom;
  }
  if (transport === undefined) {
    io.note("The selected MCP catalog definition has no usable transport.");
    return SETUP_BACK;
  }

  const defaultName = seed?.name ?? catalog?.serverName ?? "custom";
  const apps = appChoices(context, catalog?.supportedApps, seed?.apps ?? []);
  if (apps.eligible.length === 0 && (seed?.apps.length ?? 0) === 0) {
    io.note("No detected, managed, compatible application can receive this MCP server.");
    return undefined;
  }

  let name = defaultName;
  // A server nothing has targeted yet — a catalog row on its first visit, or a custom one added
  // during this step — proposes every application that can take it. Proposing none would be a
  // form whose own default the next question refuses.
  let selectedApps = seed === undefined || seed.apps.length === 0 ? apps.eligible : seed.apps;
  for (;;) {
    const result = await io.ask([
      textQuestion("mcp-name", "Name", "Configuration name", name),
      {
        id: "mcp-apps",
        initial: selectedApps,
        kind: "multiselect",
        label: "Applications",
        options: apps.options,
        prompt: "Which applications should enable this server?",
      },
    ]);
    if (result === "aborted") {
      return SETUP_ABORTED;
    }
    if (result === "back") {
      return SETUP_BACK;
    }

    name = answerText(result["mcp-name"]);
    selectedApps = selectedValues(result["mcp-apps"]);
    const problem = entryProblem(name, selectedApps, taken);
    if (problem !== undefined) {
      io.note(problem);
      // Re-asking is what a person does with the correction. A run answering its own questions
      // would be asked the same thing forever, so it stops here with the reason on the record.
      if (!context.interactive) {
        return SETUP_ABORTED;
      }
      continue;
    }
    return Object.freeze({
      apps: Object.freeze([...new Set(selectedApps)]),
      ...(catalog === undefined ? {} : { catalogId: catalog.id }),
      name,
      transport,
    });
  }
}

/**
 * Why the form cannot be accepted, including what the manifest schema would refuse on write.
 *
 * Uniqueness belongs here and not only there: the name is the key written into an application's
 * own configuration, so two rows claiming it describe two desired states for one key. Caught at
 * the form that is one line to re-type; caught at serialization it would end the run after every
 * question had been answered.
 */
function entryProblem(
  name: string,
  apps: readonly string[],
  taken: readonly AuraManifestMcpServer[],
): string | undefined {
  const nameProblem = mcpServerNameProblem(name);
  if (nameProblem !== undefined) {
    return `MCP server $.name ${nameProblem}.`;
  }
  if (apps.length === 0) {
    return "MCP server $.apps must select at least one application.";
  }
  const selected = new Set(apps);
  const clash = taken.some(
    (server) => server.name === name && server.apps.some((app) => selected.has(app)),
  );
  return clash
    ? `MCP server $.name ${name} is already configured globally for an application selected here. Choose another name.`
    : undefined;
}

interface AppChoices {
  readonly eligible: readonly string[];
  readonly options: readonly WizardOption[];
}

function appChoices(
  context: SetupStepContext,
  supportedApps: readonly string[] | undefined,
  existingApps: readonly string[],
): AppChoices {
  const managed = new Set(managedAppIdList(context));
  const offered = new Set(context.appCatalog.map(catalogEntryId));
  const hidden = existingApps.filter((id) => !offered.has(id));
  const eligible = context.appCatalog
    .filter((entry) => appDisabledReason(entry, managed, supportedApps) === undefined)
    .map(catalogEntryId);
  return {
    eligible,
    options: [
      ...context.appCatalog.map((entry) => {
        const disabledNote = appDisabledReason(entry, managed, supportedApps);
        return {
          ...(disabledNote === undefined ? {} : { disabled: true, disabledNote }),
          label: safe(catalogEntryName(entry)),
          value: catalogEntryId(entry),
        };
      }),
      ...hidden.map((id) => ({
        disabled: true,
        disabledNote: "adapter is not available in this build",
        label: safe(id),
        value: id,
      })),
    ],
  };
}

function appDisabledReason(
  entry: AppCatalogEntry,
  managed: ReadonlySet<string>,
  supportedApps: readonly string[] | undefined,
): string | undefined {
  const id = catalogEntryId(entry);
  if (supportedApps !== undefined && !supportedApps.includes(id)) {
    return "not supported by this catalog server";
  }
  if (entry.kind === "undetected") {
    return "not detected";
  }
  if (!managed.has(id)) {
    return "not managed by Aura";
  }
  if (!entry.supportsMcp) {
    return "adapter cannot write MCP configuration";
  }
  if (entry.app.support.status === "unsupported") {
    return "installed version is unsupported";
  }
  return undefined;
}
