import { delimiter, isAbsolute } from "node:path";
import type { Writable } from "node:stream";

// Deep import on purpose: see the note in run.ts.
import { Command, Option, type BaseContext } from "clipanion/lib/advanced/index.js";

import {
  buildWorkspaceModel,
  createEnvironment,
  describeFailure,
  runChecks,
  type CheckDiagnostic,
  type EnvironmentBootOptions,
  type PluginRegistry,
} from "@tryaura/core";

import { runFixes } from "./fix.js";
import { createCheckReport } from "./report.js";
import {
  renderExplanation,
  renderExplanationJson,
  renderHuman,
  renderJson,
  safe,
} from "./render.js";
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
    examples: [
      ["Run all checks", "$0 check"],
      ["Emit machine-readable output", "$0 check --json"],
      ["Show what a failing plugin reported", "$0 check --detail"],
      ["Explain one check without scanning", "$0 check --explain ENV-001"],
      ["Explain one check as JSON", "$0 check --explain ENV-001 --json"],
      ["See what fixing would change, without writing", "$0 check --fix --dry-run"],
      ["Apply fixes after confirming them", "$0 check --fix"],
      ["Apply fixes without being asked", "$0 check --fix --yes"],
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
  home = Option.String("--home", { description: "Override the home directory." });
  json = Option.Boolean("--json", false, { description: "Emit JSON instead of human output." });
  pathValue = Option.String("--path", { description: "Override the executable search path." });
  yes = Option.Boolean("--yes", false, {
    description: "Apply fixes without asking. Required when stdin is not a terminal.",
  });

  // fallow-ignore-next-line unused-class-member -- Clipanion invokes registered command handlers.
  async execute(): Promise<CliExitCode> {
    const rejection = this.rejectInvalidOptions();
    if (rejection !== undefined) {
      this.context.stderr.write(`${this.context.branding.displayName}: ${rejection}\n`);
      return 2;
    }

    if (this.explain !== undefined) {
      return this.explainCheck(this.explain);
    }

    try {
      const environment = createEnvironment(this.environmentOptions());
      let scan = await buildWorkspaceModel({
        adapters: this.context.registry.adapters,
        environment,
      });
      let run = runChecks(this.context.registry.checks, scan.model);
      let fixDiagnostics: readonly CheckDiagnostic[] = [];

      if (this.fix) {
        const outcome = await runFixes({
          branding: this.context.branding,
          checks: this.context.registry.checks,
          dryRun: this.dryRun,
          environment,
          findings: run.findings,
          model: scan.model,
          stderr: this.context.stderr,
          stdin: this.context.stdin,
          stdout: this.context.stdout,
          withDetail: this.detail,
          yes: this.yes,
        });
        if (outcome.exitCode !== undefined) {
          return outcome.exitCode;
        }
        fixDiagnostics = outcome.diagnostics;
        if (outcome.applied) {
          scan = await buildWorkspaceModel({
            adapters: this.context.registry.adapters,
            environment,
          });
          run = runChecks(this.context.registry.checks, scan.model);
        }
      }

      const report = createCheckReport({
        checkDiagnostics: [...run.diagnostics, ...fixDiagnostics],
        checks: this.context.registry.checks,
        findings: run.findings,
        scanDiagnostics: scan.diagnostics,
        skipped: scan.skipped,
        withDetail: this.detail,
      });

      if (this.json) {
        renderJson(report, this.context.report);
      } else {
        renderHuman(report, this.context.branding, this.context.stdout);
      }

      return report.exitCode;
    } catch (error) {
      return this.reportUnexpectedFailure(error);
    }
  }

  /** The first reason, if any, that this command line cannot mean what the user intended. */
  private rejectInvalidOptions(): string | undefined {
    return (
      this.rejectInvalidFixOptions() ??
      this.rejectInvalidExplainOptions() ??
      this.rejectInvalidPathOptions()
    );
  }

  /** Refuses scan-only flags alongside `--explain`, which never scans. */
  private rejectInvalidExplainOptions(): string | undefined {
    // `--detail` widens what a *scan* reports about a misbehaving plugin and `--fix` rewrites what
    // one found, and `--explain` never scans, so neither has anything to act on. `--json` is
    // supported: an explanation is exactly the kind of thing another tool wants to read.
    if (this.explain !== undefined && (this.detail || this.fix)) {
      return `--explain cannot be combined with ${this.detail ? "--detail" : "--fix"}`;
    }

    return undefined;
  }

  /**
   * Refuses a path override that cannot mean what the user intended.
   *
   * Both flags are handed to adapters, which build the paths Aura reads out of them. A relative
   * `--home` would otherwise surface much later as one "this is a bug in the adapter" diagnostic per
   * installed application, blaming every plugin for a typo in the command line.
   */
  private rejectInvalidPathOptions(): string | undefined {
    if (this.home !== undefined && !isAbsolute(this.home)) {
      return `--home must be an absolute path. Received: ${safe(this.home)}`;
    }

    if (this.pathValue !== undefined) {
      // An empty entry means "the current directory" to most tools, which is how a search path
      // starts resolving executables out of whatever directory Aura happened to be run from.
      const loose = this.pathValue
        .split(delimiter)
        .filter((entry) => !isAbsolute(entry))
        .map((entry) => (entry === "" ? "(empty)" : safe(entry)));

      if (loose.length > 0) {
        return `--path must list absolute directories separated by "${delimiter}". Not absolute: ${loose.join(", ")}`;
      }
    }

    return undefined;
  }

  /** Refuses flag combinations that would make `--fix` mean two things at once, or nothing. */
  private rejectInvalidFixOptions(): string | undefined {
    if (this.fix && this.json) {
      return "--fix cannot be combined with --json yet; JSON fix reporting is tracked by AURA-23.";
    }
    if (!this.fix && (this.dryRun || this.yes)) {
      return `${this.dryRun ? "--dry-run" : "--yes"} only means something with --fix. Add --fix, or drop it.`;
    }
    if (this.dryRun && this.yes) {
      return "--dry-run and --yes contradict each other: one stops at the preview, the other applies without asking.";
    }

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

  /**
   * Reports a failure that is not a plugin misbehaving in a way core already models.
   *
   * The thrown text is withheld by default for the same reason a scan diagnostic withholds it: it
   * may quote the contents of a file that holds an API token.
   */
  private reportUnexpectedFailure(error: unknown): CliExitCode {
    this.context.stderr.write(
      `${this.context.branding.displayName}: check failed unexpectedly. This is a bug in a plugin or the CLI.\n`,
    );
    this.context.stderr.write(
      this.detail
        ? `  ${safe(describeFailure(error))}\n`
        : `  Re-run with --detail to see what failed.\n`,
    );
    return 2;
  }

  private environmentOptions(): EnvironmentBootOptions {
    return {
      cwd: this.context.cwd,
      environmentVariables: this.context.env,
      homeDir: this.home ?? this.context.defaultHomeDir,
      ...(this.pathValue === undefined ? {} : { path: this.pathValue }),
    };
  }
}

export class DefaultCommand extends Command<AuraCliContext> {
  // fallow-ignore-next-line unused-class-member -- Clipanion reads command metadata at registration.
  static override paths = [Command.Default];
  // fallow-ignore-next-line unused-class-member -- Clipanion reads command metadata at registration.
  static override usage = Command.Usage({ description: "Show command help." });

  // fallow-ignore-next-line unused-class-member -- Clipanion invokes registered command handlers.
  async execute(): Promise<CliExitCode> {
    this.context.stdout.write(this.cli.usage(null));
    if (this.context.branding.docsUrl !== undefined) {
      this.context.stdout.write(`\nDocs: ${this.context.branding.docsUrl}\n`);
    }
    return 0;
  }
}
