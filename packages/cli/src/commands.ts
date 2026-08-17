import type { Writable } from "node:stream";

// Deep import on purpose: see the note in run.ts.
import { Command, Option, type BaseContext } from "clipanion/lib/advanced/index.js";

import {
  buildWorkspaceModel,
  createEnvironment,
  runChecks,
  type EnvironmentBootOptions,
  type PluginRegistry,
} from "@tryaura/core";

import {
  environmentOptions,
  homeOption,
  isTerminal,
  pathOption,
  rejectInvalidPathOptions,
  reportUnexpectedFailure,
  writeOptionRejection,
} from "./command-support.js";
import { fixOptionRejection } from "./check-options.js";
import { selectChecks, type CheckSelection } from "./check-selection.js";
import { runFixes } from "./fix.js";
import { createCheckReport, type DiagnosticSource, type ReportFix } from "./report.js";
import {
  renderExplanation,
  renderExplanationJson,
  renderHuman,
  renderJson,
  renderOperationalFailureJson,
} from "./render.js";
import { safe } from "./safe-text.js";
import type { CliBranding, CliExitCode } from "./types.js";

export interface AuraCliContext extends BaseContext {
  readonly branding: CliBranding;
  readonly cwd: string;
  /** Home directory captured at the process boundary, before any `--home` override. */
  readonly defaultHomeDir: string;
  readonly registry: PluginRegistry;
  /**
   * Where machine-readable output goes.
   *
   * Separate from `stdout` so that `--json` can hand plugin output a different stream: a document
   * a script parses must not share a channel with whatever a plugin decided to print.
   */
  readonly report: Writable;
}

export class CheckCommand extends Command<AuraCliContext> {
  // fallow-ignore-next-line unused-class-member -- Clipanion reads command metadata at registration.
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
  dryRun = Option.Boolean("--dry-run", false, {
    description: "With --fix, show what would change and write nothing.",
  });
  explain = Option.String("--explain", { description: "Explain a check without scanning." });
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
  interactive = Option.Boolean("--interactive", false, {
    description: "With --fix, walk through guided remediation choices.",
  });
  pathValue = pathOption();
  yes = Option.Boolean("--yes", false, {
    description: "Apply fixes without asking. Required when stdin is not a terminal.",
  });

  // fallow-ignore-next-line unused-class-member -- Clipanion invokes registered command handlers.
  async execute(): Promise<CliExitCode> {
    const rejection = this.rejectInvalidOptions();
    if (rejection !== undefined) {
      return writeOptionRejection(this.context, rejection);
    }

    if (this.explain !== undefined) {
      return this.explainCheck(this.explain);
    }

    const selected = this.resolveSelection();
    if (selected === undefined) {
      return 2;
    }

    try {
      const environment = createEnvironment(this.environmentOptions());
      let scan = await buildWorkspaceModel({
        adapters: selected.adapters,
        environment,
        snippets: this.context.registry.snippets,
      });
      let run = runChecks(selected.checks, scan.model);
      let fixRunDiagnostics: readonly DiagnosticSource[] = [];
      let fixes: readonly ReportFix[] | undefined;
      let forcedExitCode: CliExitCode | undefined;

      if (this.fix) {
        const outcome = await runFixes({
          branding: this.context.branding,
          checks: selected.checks,
          colorDepth: this.context.colorDepth,
          dryRun: this.dryRun,
          environment,
          findings: run.findings,
          interactive: this.interactive,
          model: scan.model,
          stderr: this.context.stderr,
          stdin: this.context.stdin,
          stateHomeDir: this.context.defaultHomeDir,
          stdout: this.context.stdout,
          withDetail: this.detail,
          yes: this.yes,
        });
        forcedExitCode = outcome.exitCode;
        fixRunDiagnostics = [
          ...outcome.diagnostics.map((diagnostic): DiagnosticSource => ({
            detail: diagnostic.detail,
            id: diagnostic.checkId,
            message: diagnostic.message,
            phase: "fix",
          })),
          ...outcome.fixDiagnostics,
        ];
        fixes = outcome.fixes;
        if (outcome.applied) {
          scan = await buildWorkspaceModel({
            adapters: selected.adapters,
            environment,
            snippets: this.context.registry.snippets,
          });
          run = runChecks(selected.checks, scan.model);
        }
      }

      const report = createCheckReport({
        adapters: selected.adapters,
        apps: scan.model.apps,
        checkDiagnostics: run.diagnostics,
        checks: selected.checks,
        findings: run.findings,
        fixDiagnostics: fixRunDiagnostics,
        fixes,
        forcedExitCode,
        scanDiagnostics: scan.diagnostics,
        skipped: scan.skipped,
        withDetail: this.detail,
      });

      if (this.json) {
        renderJson(report, this.context.report);
      } else {
        renderHuman(report, this.context.branding, this.context.stdout, this.context.colorDepth);
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
      );
    }
  }

  private rejectInvalidOptions(): string | undefined {
    return (
      this.rejectInvalidJsonOptions() ??
      this.rejectInvalidFixOptions() ??
      this.rejectInvalidExplainOptions() ??
      rejectInvalidPathOptions(this.home, this.pathValue)
    );
  }

  private rejectInvalidExplainOptions(): string | undefined {
    // `--detail` widens what a *scan* reports about a misbehaving plugin and `--fix` rewrites what
    // one found, and `--explain` never scans, so neither has anything to act on. `--json` is
    // supported: an explanation is exactly the kind of thing another tool wants to read.
    if (
      this.explain !== undefined &&
      (this.detail || this.fix || this.interactive || this.only.length > 0)
    ) {
      const incompatible = this.detail
        ? "--detail"
        : this.fix
          ? "--fix"
          : this.interactive
            ? "--interactive"
            : "--only";
      return `--explain cannot be combined with ${incompatible}`;
    }

    return undefined;
  }

  private rejectInvalidFixOptions(): string | undefined {
    return fixOptionRejection({
      dryRun: this.dryRun,
      fix: this.fix,
      interactive: this.interactive,
      stdinTerminal: isTerminal(this.context.stdin),
      stdoutTerminal: isTerminal(this.context.stdout),
      yes: this.yes,
    });
  }

  private rejectInvalidJsonOptions(): string | undefined {
    if (this.jsonVersion !== undefined && !this.json) {
      return "--json-version only means something with --json. Add --json, or drop it.";
    }
    if (this.jsonVersion !== undefined && this.jsonVersion !== "1") {
      return `unsupported --json-version: ${safe(this.jsonVersion)}. Supported versions: 1`;
    }
    return undefined;
  }

  private resolveSelection(): CheckSelection | undefined {
    const result = selectChecks(
      this.context.registry.checks,
      this.context.registry.adapters,
      this.only,
    );
    if (result.status === "selected") {
      return result.selection;
    }
    this.context.stderr.write(`${this.context.branding.displayName}: ${result.message}\n`);
    return undefined;
  }

  /**
   * Resolves a check id the way a developer typed it.
   *
   * Ids are upper-case by convention, so matching them case-sensitively turns `env-001` into an
   * error for what is unambiguously one check. An exact match still wins, which keeps two ids that
   * differ only in case resolvable.
   */
  private explainCheck(id: string): CliExitCode {
    const checks = this.context.registry.checks;
    const check =
      checks.find((candidate) => candidate.id === id) ??
      checks.find((candidate) => candidate.id.toLowerCase() === id.toLowerCase());
    if (check === undefined) {
      const available = checks.map((candidate) => candidate.id).join(", ");
      this.context.stderr.write(
        `${this.context.branding.displayName}: unknown check ID: ${safe(id)}\n`,
      );
      if (available !== "") {
        this.context.stderr.write(`Available check IDs: ${safe(available)}\n`);
      }
      return 2;
    }

    if (this.json) {
      renderExplanationJson(check, this.context.report);
    } else {
      renderExplanation(check, this.context.branding, this.context.stdout);
    }
    return 0;
  }

  private environmentOptions(): EnvironmentBootOptions {
    return environmentOptions(this.context, this.home, this.pathValue);
  }
}
