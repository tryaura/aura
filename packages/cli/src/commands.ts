import { delimiter, isAbsolute } from "node:path";
import type { Writable } from "node:stream";

// Deep import on purpose: see the note in run.ts.
import { Command, Option, type BaseContext } from "clipanion/lib/advanced/index.js";

import {
  buildWorkspaceModel,
  createEnvironment,
  describeFailure,
  runChecks,
  type EnvironmentBootOptions,
  type PluginRegistry,
} from "@tryaura/core";

import { createCheckReport } from "./report.js";
import { renderHuman, renderJson, safe } from "./render.js";
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
    ],
  });

  detail = Option.Boolean("--detail", false, {
    description: "Include the failing plugin's own error text. May contain file contents.",
  });
  home = Option.String("--home", { description: "Override the home directory." });
  json = Option.Boolean("--json", false, { description: "Emit JSON instead of human output." });
  pathValue = Option.String("--path", { description: "Override the executable search path." });

  // fallow-ignore-next-line unused-class-member -- Clipanion invokes registered command handlers.
  async execute(): Promise<CliExitCode> {
    const rejection = this.rejectInvalidOptions();
    if (rejection !== undefined) {
      this.context.stderr.write(`${this.context.branding.displayName}: ${rejection}\n`);
      return 2;
    }

    try {
      const environment = createEnvironment(this.environmentOptions());
      const scan = await buildWorkspaceModel({
        adapters: this.context.registry.adapters,
        environment,
      });
      const run = runChecks(this.context.registry.checks, scan.model);
      const report = createCheckReport({
        checkDiagnostics: run.diagnostics,
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

  /**
   * Refuses a path override that cannot mean what the user intended.
   *
   * Both flags are handed to adapters, which build the paths Aura reads out of them. A relative
   * `--home` would otherwise surface much later as one "this is a bug in the adapter" diagnostic per
   * installed application, blaming every plugin for a typo in the command line.
   */
  private rejectInvalidOptions(): string | undefined {
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
