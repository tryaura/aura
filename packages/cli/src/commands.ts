// Deep import on purpose: see the note in run.ts.
import { Command, Option } from "clipanion/lib/advanced/index.js";

import type { AuraCliContext } from "./cli-context.js";
import {
  buildWorkspaceModel,
  applyRequiredMcpServers,
  createEnvironment,
  createFileReader,
  createMcpUrlRequester,
  enabledChecks,
  readAuraManifest,
  resolveAuraManifestPath,
  runChecks,
} from "@tryaura/core";

import {
  environmentOptions,
  homeOption,
  pathOption,
  reportUnexpectedFailure,
  writeOptionRejection,
} from "./command-support.js";
import { repoPresetNote, reportConfiguration, resolveCheckConfiguration } from "./check-config.js";
import { explainCheck } from "./check-explain.js";
import { rejectInvalidCheckOptions } from "./check-option-rejection.js";
import {
  disableOption,
  enableOption,
  noCacheOption,
  parseConfigurationFlagArrays,
  presetOption,
  severityOption,
  thresholdOption,
} from "./config-options.js";
import { disabledOnlySelector, resolveCheckSelection } from "./check-selection-resolve.js";
import { fixPassDiagnostics } from "./check-fix-pass.js";
import { runFixes } from "./fix.js";
import { createCheckReport, type DiagnosticSource, type ReportFix } from "./report.js";
import { renderJson, renderOperationalFailureJson } from "./render.js";
import { renderHumanCheckReport } from "./render-human.js";
import { pathDisplayRoots } from "./render-human-types.js";
import { safe } from "./safe-text.js";
import { checkRunEvent, checkRunFlags, elapsedMs, fixRunEvent } from "./telemetry-events.js";
import type { CliExitCode } from "./types.js";

export type { AuraCliContext } from "./cli-context.js";

export class CheckCommand extends Command<AuraCliContext> {
  static override paths = [["check"]];
  // fallow-ignore-next-line unused-class-member -- Clipanion reads command metadata at registration.
  static override usage = Command.Usage({
    description: "Inspect the current AI agent setup.",
    details:
      "Exit codes: 0 clean/info, 1 warning, 2 errors or usage/state conflicts, 3 operational failures.",
    examples: [
      ["Run all checks", "$0 check"],
      ["Emit machine-readable output", "$0 check --json"],
      ["Run one category for one application", "$0 check --only ENV --only claude"],
      ["Show what a failing plugin reported", "$0 check --detail"],
      ["Explain one check without scanning", "$0 check --explain ENV-001"],
      ["Explain one check as JSON", "$0 check --explain ENV-001 --json"],
      ["See what fixing would change, without writing", "$0 check --fix --dry-run"],
      ["Apply fixes after confirming them", "$0 check --fix"],
      ["Apply fixes without being asked", "$0 check --fix --yes"],
      ["Choose guided resolutions", "$0 check --fix --interactive"],
    ],
  });

  detail = Option.Boolean("--detail", false, {
    description: "Include the failing plugin's own error text. May contain file contents.",
  });
  disable = disableOption();
  dryRun = Option.Boolean("--dry-run", false, {
    description: "With --fix, show what would change and write nothing.",
  });
  explain = Option.String("--explain", { description: "Explain a check without scanning." });
  enable = enableOption();
  fix = Option.Boolean("--fix", false, {
    description: "Preview fixes and apply them after confirmation.",
  });
  home = homeOption();
  json = Option.Boolean("--json", false, { description: "Emit JSON instead of human output." });
  jsonVersion = Option.String("--json-version", {
    description: "Select the machine-readable contract version. Supported: 1.",
  });
  only = Option.Array("--only", [], {
    description: "Run only a check ID, category, or application. Repeatable.",
  });
  online = Option.Boolean("--online", false, {
    description: "Probe remote MCP URLs with bounded network requests.",
  });
  noCache = noCacheOption();
  interactive = Option.Boolean("--interactive", false, {
    description: "With --fix, walk through guided remediation choices.",
  });
  pathValue = pathOption();
  preset = presetOption();
  severity = severityOption();
  threshold = thresholdOption();
  verbose = Option.Boolean("--verbose", false, {
    description: "Show every occurrence, location, passed check, and application.",
  });
  yes = Option.Boolean("--yes", false, {
    description: "Apply fixes without asking. Required when stdin is not a terminal.",
  });

  // fallow-ignore-next-line complexity, unused-class-member -- coordinates the complete check and fix lifecycle.
  async execute(): Promise<CliExitCode> {
    const rejection = rejectInvalidCheckOptions({
      detail: this.detail,
      dryRun: this.dryRun,
      explaining: this.explain !== undefined,
      fix: this.fix,
      home: this.home,
      interactive: this.interactive,
      json: this.json,
      jsonVersion: this.jsonVersion,
      online: this.online,
      only: this.only,
      pathValue: this.pathValue,
      stdin: this.context.stdin,
      stdout: this.context.stdout,
      verbose: this.verbose,
      yes: this.yes,
    });
    if (rejection !== undefined) {
      return writeOptionRejection(this.context, rejection);
    }

    const flags = parseConfigurationFlagArrays(
      this.disable,
      this.enable,
      this.severity,
      this.threshold,
    );
    if (flags.status === "invalid") {
      return writeOptionRejection(this.context, flags.message);
    }

    const environment = createEnvironment(
      environmentOptions(this.context, this.home, this.pathValue),
    );
    const manifestPath = resolveAuraManifestPath(environment.homeDir);
    const manifest = readAuraManifest(manifestPath, await createFileReader().read(manifestPath));
    const configured = await resolveCheckConfiguration({
      cliLayer: flags.layer,
      cliReference: this.preset,
      context: this.context,
      environment,
      manifest,
      noCache: this.noCache,
      online: this.online,
    });
    if (configured.status === "invalid") {
      this.context.stderr.write(
        `${this.context.branding.displayName}: ${safe(configured.message)}\n`,
      );
      return 2;
    }
    const configuration = reportConfiguration(configured);

    if (this.explain !== undefined) {
      return explainCheck(this.explain, {
        ...this.context,
        checks: this.context.registry.checks,
        config: configured.config,
        configuration,
        json: this.json,
      });
    }

    const selected = resolveCheckSelection(this.context, this.only);
    if (selected === undefined) {
      return 2;
    }
    const disabledSelector = disabledOnlySelector(
      this.context.registry.checks,
      this.only,
      configured.config,
    );
    if (disabledSelector !== undefined) {
      this.context.stderr.write(
        `${this.context.branding.displayName}: check ${safe(disabledSelector)} is disabled by configuration; add --enable ${safe(disabledSelector)} to run it.\n`,
      );
      return 2;
    }
    const activeChecks = enabledChecks(selected.checks, configured.config);

    // Held across both scans, then closed once so pooled sockets do not keep the process alive.
    const requester = this.online ? createMcpUrlRequester(this.context.env) : undefined;
    try {
      const startedAt = environment.now();
      const scanOptions = {
        adapters: selected.adapters,
        environment,
        mcpCatalog: this.context.registry.mcpServers,
        mcpProbes: requester === undefined ? {} : { urlRequest: requester.request },
        skills: this.context.registry.skills,
        snippets: this.context.registry.snippets,
      };
      let scan = await buildWorkspaceModel(scanOptions);
      let projected = applyRequiredMcpServers(scan.model, configured.config);
      let model = projected.model;
      let run = runChecks(activeChecks, model, configured.config);
      let fixRunDiagnostics: readonly DiagnosticSource[] = [];
      let fixes: readonly ReportFix[] | undefined;
      let forcedExitCode: CliExitCode | undefined;

      if (this.fix) {
        const outcome = await runFixes({
          branding: this.context.branding,
          checks: activeChecks,
          colorDepth: this.context.colorDepth,
          dryRun: this.dryRun,
          environment,
          findings: run.findings,
          interactive: this.interactive,
          model,
          stderr: this.context.stderr,
          stdin: this.context.stdin,
          stateHomeDir: this.context.defaultHomeDir,
          stdout: this.context.stdout,
          withDetail: this.detail,
          yes: this.yes,
        });
        forcedExitCode = outcome.exitCode;
        fixRunDiagnostics = fixPassDiagnostics(outcome);
        fixes = outcome.fixes;
        if (outcome.applied) {
          scan = await buildWorkspaceModel(scanOptions);
          projected = applyRequiredMcpServers(scan.model, configured.config);
          model = projected.model;
          run = runChecks(activeChecks, model, configured.config);
        }
      }

      const report = createCheckReport({
        adapters: selected.adapters,
        apps: scan.model.apps,
        checkDiagnostics: run.diagnostics,
        checks: activeChecks,
        configuration,
        findings: run.findings,
        fixDiagnostics: fixRunDiagnostics,
        fixes,
        forcedExitCode,
        scanDiagnostics: [...scan.diagnostics, ...projected.diagnostics],
        skipped: scan.skipped,
        withDetail: this.detail,
      });

      if (this.json) {
        renderJson(report, this.context.report);
      } else {
        const note = repoPresetNote(configured, this.context.branding);
        renderHumanCheckReport(report, this.context.branding, this.context.stdout, {
          checks: activeChecks,
          colorDepth: this.context.colorDepth,
          notes: note === undefined ? [] : [note],
          roots: pathDisplayRoots(environment, model.projectRoot),
          verbose: this.verbose,
        });
      }

      this.context.telemetry.record(
        checkRunEvent(report, checkRunFlags(this), elapsedMs(environment, startedAt)),
      );
      if (fixes !== undefined) {
        this.context.telemetry.record(
          fixRunEvent(fixes, this.dryRun, this.interactive, report.summary.exitCode),
        );
      }
      return report.summary.exitCode;
    } catch (error) {
      // `--json` promises one parseable document on stdout even when the run itself fails.
      if (this.json) {
        renderOperationalFailureJson(error, this.detail, this.context.report);
      }
      return reportUnexpectedFailure(
        error,
        "check",
        this.context.branding,
        this.detail,
        this.context.stderr,
        this.context.telemetry,
      );
    } finally {
      await requester?.close();
    }
  }
}
