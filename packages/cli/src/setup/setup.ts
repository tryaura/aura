import type { Writable } from "node:stream";

import type {
  AuraConfigurationLayer,
  AuraEffectiveConfig,
  Environment,
  SetupRunOutcome,
  TelemetrySetupActions,
} from "@tryaura/aura-sdk";
import { buildWorkspaceModel, type PluginRegistry } from "@tryaura/core";
import { pluralize } from "@tryaura/core/pluralize";

import { safe } from "../safe-text.js";
import { applySetupPlan, type ApplySetupPlanOptions } from "./apply-retry.js";
import { bootSetup, projectRescan } from "./boot.js";
import { runPass, type PreparedPlan } from "./pass.js";
import { elapsedMs, setupActions, setupRunEvent } from "../telemetry-events.js";
import type { TelemetryRecorder } from "../telemetry.js";
import type { CliBranding, CliExitCode } from "../types.js";
import { buildAppCatalog } from "./catalog.js";
import { createSetupCatalogs } from "./catalogs.js";
import { endOnGreen, gatherFindings } from "./green.js";
import { presetCheckSummary } from "./preset-policy.js";
import { createSnippetCatalog } from "./snippets.js";
import { SETUP_STEPS } from "./steps/index.js";
import { type GatherStart } from "./gather.js";
import type { GatheredSetup, SetupPresetContext, SetupStep } from "./types.js";
import type { WizardIo } from "./wizard-types.js";

/** Everything one `setup` run needs, so the flow does not reach back into the command object. */
export interface SetupRequest {
  readonly branding: CliBranding;
  /** How much color the closing report may use. */
  readonly colorDepth: number;
  readonly cliLayer?: AuraConfigurationLayer | undefined;
  readonly cliReference?: string | undefined;
  readonly defaultPreset?: string | undefined;
  readonly defaults?: AuraConfigurationLayer | undefined;
  readonly dryRun: boolean;
  readonly environment: Environment;
  /** False when `io` answers for the user, which the MCP step reads before proposing a default. */
  readonly interactive: boolean;
  readonly io: WizardIo;
  readonly noCache?: boolean | undefined;
  readonly registry: PluginRegistry;
  /** Home captured before `--home`, used for locks shared by every run from this process boundary. */
  readonly stateHomeDir: string;
  readonly stderr: Writable;
  readonly stdout: Writable;
  /**
   * The steps this run gathers, defaulting to every registered one.
   *
   * `setup --add <kind>` narrows it to a single step through {@link selectSetupSteps}; tests use the
   * same seam to exercise one step in isolation.
   */
  readonly steps?: readonly SetupStep[] | undefined;
  /** The run's telemetry recorder. A no-op unless the distribution composed a sink. */
  readonly telemetry: TelemetryRecorder;
  /** Whether the summary may quote the contents of the files it rewrites. */
  readonly withDetail: boolean;
}

/**
 * The `setup` flow: scan, gather selections, plan, confirm once, apply, end on green.
 *
 * Steps never write and the plan applies through the fix-plan kernel after one confirmation, so
 * backing out anywhere before that leaves the filesystem as the run found it — with one exception:
 * an accepted repository preset trust is recorded during boot, because consent the user has already
 * given should not be discarded by a change of mind about the wizard. The closing line names it
 * when that happened. A machine that already matches the desired state produces an empty operation
 * plan and skips both confirmation and the journal — the fifth run is the first run.
 */
export async function runSetup(request: SetupRequest): Promise<CliExitCode> {
  const { branding, environment, io, stdout } = request;
  const startedAt = environment.now();
  // The one telemetry funnel: every return below passes through it, so a run emits exactly once.
  const finish = (
    exitCode: CliExitCode,
    outcome: SetupRunOutcome,
    extras?: {
      readonly actions?: TelemetrySetupActions | undefined;
      readonly appliedOperationCount?: number | undefined;
    },
  ): CliExitCode => {
    request.telemetry.record(
      setupRunEvent({
        actions: extras?.actions,
        appliedOperationCount: extras?.appliedOperationCount,
        durationMs: elapsedMs(environment, startedAt),
        exitCode,
        outcome,
      }),
    );
    return exitCode;
  };
  stdout.write(`${branding.displayName} setup\n\n`);

  const booted = await bootSetup(request, environment);
  if (booted.status === "invalid") {
    request.stderr.write(`${branding.displayName}: ${safe(booted.message)}\n`);
    return finish(2, "unusable");
  }
  if (booted.status === "aborted") {
    stdout.write("\nLeft everything as it was.\n");
    return finish(1, "aborted");
  }
  const { activeChecks, configured, effectiveModel, effectiveScan, projected, scan } = booted;
  const model = scan.model;

  const steps = request.steps ?? SETUP_STEPS;
  // After the early return, and only when a selected step reads them: the duplicate scan among the
  // checks is quadratic in the paragraphs it compares, and `endOnGreen` runs its own pass anyway.
  const initialFindings = steps.some((step) => step.needsFindings === true)
    ? gatherFindings(activeChecks, effectiveModel, io, configured.config)
    : undefined;

  const catalogs = createSetupCatalogs({
    config: configured.config,
    environment,
    interactive: request.interactive,
    model: effectiveModel,
    preset: configured.preset,
    presetNotes: [
      ...configured.notes,
      ...projected.diagnostics.map((diagnostic) => diagnostic.message),
    ],
    presetOrigin: configured.presetOrigin,
    registry: request.registry,
  });
  const preset = setupPresetContext(request, configured.config, configured.preset);
  const repoPreset = booted.repoPreset;

  const stepContext = {
    appCatalog: buildAppCatalog(request.registry.adapters, model, scan.skipped),
    ...(initialFindings === undefined ? {} : { findings: initialFindings }),
    interactive: request.interactive,
    isEnvironmentVariableSet: (name: string) => environment.readVariable(name) !== undefined,
    manifest: model.manifest,
    mcpCatalog: catalogs.mcpCatalog,
    model: effectiveModel,
    skillCatalog: catalogs.skillCatalog,
    snippetCatalog: createSnippetCatalog(
      request.registry.snippets,
      model.manifest,
      preset?.snippets ?? [],
    ),
    ...(preset === undefined ? {} : { preset }),
    ...(repoPreset === undefined ? {} : { repoPreset }),
  };

  // The confirmation can send the user ← back into the last step, so gather → plan → confirm
  // repeats until the plan is accepted, declined, or aborted. Nothing is written inside the loop.
  let start: GatherStart = { index: 0, offered: new Set(), selections: {} };
  let ready: {
    readonly gathered: GatheredSetup;
    readonly planInputs: ApplySetupPlanOptions["planInputs"];
    readonly prepared: PreparedPlan;
  };
  for (;;) {
    const pass = await runPass(
      request,
      steps,
      stepContext,
      effectiveScan,
      start,
      activeChecks,
      configured.config,
    );
    if (pass.kind === "back") {
      start = pass.start;
      continue;
    }
    if (pass.kind === "exit") {
      return finish(pass.code, pass.outcome, { actions: plannedActions(pass.gathered) });
    }
    ready = pass;
    break;
  }

  const result = await applySetupPlan({
    planInputs: ready.planInputs,
    prepared: ready.prepared,
    request,
  });
  stdout.write(
    `\nApplied ${String(result.appliedOperationCount)} ${pluralize(result.appliedOperationCount, "operation")}.\n`,
  );
  if (result.backupId !== undefined) {
    stdout.write(
      `The previous contents are saved as backup ${safe(result.backupId)}. Run ${branding.command} undo to restore them.\n`,
    );
  }
  stdout.write("\n");

  // End on green: rescan so the checklist reports what is now on disk, not what was planned.
  const rescanned = await buildWorkspaceModel({
    adapters: request.registry.adapters,
    environment,
    mcpCatalog: request.registry.mcpServers,
    snippets: request.registry.snippets,
    skills: request.registry.skills,
  });
  const effectiveRescan = projectRescan(rescanned, configured.config);
  return finish(endOnGreen(request, effectiveRescan, activeChecks, configured.config), "applied", {
    actions: setupActions(ready.gathered),
    appliedOperationCount: result.appliedOperationCount,
  });
}

/** A pass that never reached a plan has no choices to report, which is not the same as none made. */
function plannedActions(gathered: GatheredSetup | undefined): TelemetrySetupActions | undefined {
  return gathered === undefined ? undefined : setupActions(gathered);
}

function setupPresetContext(
  request: SetupRequest,
  config: AuraEffectiveConfig,
  preset: Parameters<typeof createSetupCatalogs>[0]["preset"],
): SetupPresetContext | undefined {
  const selected = config.preset;
  if (selected === undefined || preset === undefined) {
    return undefined;
  }
  return Object.freeze({
    checkSummary: presetCheckSummary(config, "preset"),
    explicit: request.cliReference !== undefined,
    name: selected.name,
    reference: request.cliReference ?? selected.reference,
    skills: Object.freeze([...(preset.skills ?? [])]),
    snippets: Object.freeze([...(preset.snippets ?? [])]),
  });
}
