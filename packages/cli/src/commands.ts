import { Command, Option, type BaseContext } from "clipanion/lib/advanced/index.js";

import {
  buildWorkspaceModel,
  createEnvironment,
  runChecks,
  type EnvironmentBootOptions,
  type PluginRegistry,
} from "@tryaura/core";

import { createCheckReport } from "./report.js";
import { renderHuman, renderJson } from "./render.js";
import type { CliBranding, CliExitCode } from "./types.js";

export interface AuraCliContext extends BaseContext {
  readonly branding: CliBranding;
  readonly cwd: string;
  readonly defaultHomeDir?: string | undefined;
  readonly registry: PluginRegistry;
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
    ],
  });

  home = Option.String("--home", { description: "Override the home directory." });
  json = Option.Boolean("--json", false, { description: "Emit JSON instead of human output." });
  pathValue = Option.String("--path", { description: "Override the executable search path." });

  // fallow-ignore-next-line unused-class-member -- Clipanion invokes registered command handlers.
  async execute(): Promise<CliExitCode> {
    try {
      const environment = createEnvironment(this.environmentOptions());
      const scan = await buildWorkspaceModel({
        adapters: this.context.registry.adapters,
        environment,
      });
      const findings = runChecks(this.context.registry.checks, scan.model);
      const report = createCheckReport(this.context.registry.checks, findings, scan.diagnostics);

      if (this.json) {
        renderJson(report, this.context.stdout);
      } else {
        renderHuman(report, this.context.branding, this.context.stdout);
      }

      return report.exitCode;
    } catch {
      this.context.stderr.write(
        `${this.context.branding.displayName}: check failed unexpectedly. This is a bug in a plugin or the CLI.\n`,
      );
      return 2;
    }
  }

  private environmentOptions(): EnvironmentBootOptions {
    return {
      cwd: this.context.cwd,
      environmentVariables: this.context.env,
      ...(this.home === undefined
        ? this.context.defaultHomeDir === undefined
          ? {}
          : { homeDir: this.context.defaultHomeDir }
        : { homeDir: this.home }),
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
