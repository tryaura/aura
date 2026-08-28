import { chmod, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

// Deep import on purpose: see the note in run.boundary.ts.
import { Command, Option } from "clipanion/lib/advanced/index.js";

import {
  analyzeAgentSessions,
  canonicalAppId,
  createTranscriptReader,
  createEnvironment,
  createFileReader,
  type SessionAnalysis,
  type SessionSource,
} from "@tryaura/core";

import {
  environmentOptions,
  homeOption,
  rejectInvalidPathOptions,
  writeOptionRejection,
  writeRunFailure,
} from "../command-support.js";
import type { AuraCliContext } from "../commands.js";
import type { CliExitCode } from "../types.js";
import { renderSessionBrief } from "./brief.js";
import { renderSessionsReport } from "./render.js";

/** The look-back window when `--days` is not given. */
const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

/** Where `--brief` writes when no path is given, relative to the working directory. */
const DEFAULT_BRIEF_NAME = "aura-session-brief.md";

export class SessionsCommand extends Command<AuraCliContext> {
  static override paths = [["sessions"]];
  // fallow-ignore-next-line unused-class-member -- Clipanion reads command metadata at registration.
  static override usage = Command.Usage({
    description: "Summarize recent coding agent sessions.",
    details: `
      Reads the session transcripts Codex keeps under ~/.codex/sessions and Claude Code keeps under ~/.claude/projects, and reports, per working directory, how much agent time they held and where tool calls failed. Everything stays on this machine: no transcript content leaves it. The human report carries counts, durations, and bare command names; JSON and handoff briefs also carry local evidence metadata.

      Exit codes: 0 report produced, 2 invalid usage, 3 operational failures.
    `,
    examples: [
      ["Summarize the last 30 days", "$0 sessions"],
      ["Widen the window", "$0 sessions --days 90"],
      ["Write a handoff brief for a coding agent", "$0 sessions --brief"],
      ["Emit machine-readable output", "$0 sessions --json"],
      ["Analyze one source only", "$0 sessions --source claude-code"],
    ],
  });

  brief = Option.String("--brief", {
    description: `Write an agent handoff brief. Bare --brief writes ${DEFAULT_BRIEF_NAME}; a custom target needs the joined form, --brief=<path>.`,
    tolerateBoolean: true,
  });
  days = Option.String("--days", {
    description: `Look back this many days. Default ${DEFAULT_DAYS}, at most ${MAX_DAYS}.`,
  });
  detailed = Option.Boolean("--detailed", false, {
    description: "Add one row per recorded tool call to the JSON document.",
  });
  force = Option.Boolean("--force", false, {
    description: "Replace an existing --brief target.",
  });
  home = homeOption();
  json = Option.Boolean("--json", false, { description: "Emit JSON instead of human output." });
  source = Option.String("--source", {
    description: "Analyze one source only: codex or claude-code. Default: both.",
  });
  verbose = Option.Boolean("--verbose", false, {
    description: "List every directory instead of only the busiest.",
  });

  // fallow-ignore-next-line unused-class-member -- Clipanion invokes registered command handlers.
  async execute(): Promise<CliExitCode> {
    const days = this.parseDays();
    if (days === undefined) {
      return writeOptionRejection(
        this.context,
        `--days must be a whole number between 1 and ${MAX_DAYS}.`,
      );
    }
    const sources = this.parseSources();
    if (sources === "invalid") {
      return writeOptionRejection(this.context, "--source must be codex or claude-code.");
    }
    const rejection =
      this.rejectBriefOptions() ??
      this.rejectDetailedOption() ??
      rejectInvalidPathOptions(this.home, undefined);
    if (rejection !== undefined) {
      return writeOptionRejection(this.context, rejection);
    }

    try {
      return await this.report(days, sources);
    } catch (error) {
      writeRunFailure(error, this.context.branding, this.context.stderr);
      return 3;
    }
  }

  private async report(
    days: number,
    sources: readonly SessionSource[] | undefined,
  ): Promise<CliExitCode> {
    const environment = createEnvironment(environmentOptions(this.context, this.home, undefined));
    const analysis = await analyzeAgentSessions({
      days,
      detail: this.detailed ? "calls" : "summary",
      homeDir: environment.homeDir,
      now: environment.now(),
      reader: createFileReader(),
      sources,
      transcriptReader: createTranscriptReader(),
    });

    if (this.json) {
      // One parseable document on stdout; `report` stays pointed there when stdout is redirected.
      // `source` predates multi-source analysis and stays frozen at its historical value whenever
      // Codex was in scope; `sources` is the authoritative list.
      const source = analysis.sources.includes("codex") ? "codex" : analysis.sources[0];
      this.context.report.write(`${JSON.stringify({ days, source, ...analysis })}\n`);
      return 0;
    }
    renderSessionsReport(analysis, {
      days,
      homeDir: environment.homeDir,
      stdout: this.context.stdout,
      verbose: this.verbose,
    });
    if (this.briefRequested()) {
      await this.writeBrief(analysis, days, environment.cwd);
    }
    return 0;
  }

  private briefRequested(): boolean {
    return this.brief !== undefined && this.brief !== false;
  }

  /** Writes the handoff brief and prints the one command that hands it to a coding agent. */
  private async writeBrief(analysis: SessionAnalysis, days: number, cwd: string): Promise<void> {
    const named = typeof this.brief === "string" ? this.brief : DEFAULT_BRIEF_NAME;
    const target = isAbsolute(named) ? named : join(cwd, named);
    try {
      await writeFile(target, renderSessionBrief(analysis, days), {
        encoding: "utf8",
        flag: this.force ? "w" : "wx",
        mode: 0o600,
      });
      if (this.force) {
        await chmod(target, 0o600);
      }
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new Error(
          `Brief target already exists: ${named}. Choose another path or pass --force to replace it.`,
        );
      }
      throw error;
    }
    const shown = typeof this.brief === "string" ? named : `./${DEFAULT_BRIEF_NAME}`;
    // The printed runner matches the analyzed sources; Codex keeps priority when both were read.
    const runner = analysis.sources.includes("codex") ? "codex exec" : "claude";
    this.context.stdout.write(
      `\nBrief written to ${named}\nRun: ${runner} ${shellQuote(`Follow the instructions in ${shown}`)}\n`,
    );
  }

  /** `undefined` means every source; `"invalid"` means the selector did not resolve. */
  private parseSources(): readonly SessionSource[] | "invalid" | undefined {
    if (this.source === undefined) {
      return undefined;
    }
    const canonical = canonicalAppId(this.source);
    return canonical === "codex" || canonical === "claude-code" ? [canonical] : "invalid";
  }

  private rejectDetailedOption(): string | undefined {
    if (this.detailed && !this.json) {
      return "--detailed requires --json: per-call rows are machine output.";
    }
    return undefined;
  }

  private rejectBriefOptions(): string | undefined {
    if (this.briefRequested() && this.json) {
      return "--brief and --json contradict each other: the brief is the handoff document; use --json alone for raw data.";
    }
    if (this.brief === "") {
      return "--brief needs a file path, or no value for the default.";
    }
    if (typeof this.brief === "string" && /[\p{Cc}\p{Cf}]/u.test(this.brief)) {
      return "--brief paths cannot contain control or Unicode format characters.";
    }
    if (this.force && !this.briefRequested()) {
      return "--force requires --brief.";
    }
    return undefined;
  }

  private parseDays(): number | undefined {
    if (this.days === undefined) {
      return DEFAULT_DAYS;
    }
    const parsed = Number(this.days);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_DAYS) {
      return undefined;
    }
    return parsed;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

/** One POSIX-shell argument, including paths with quotes or expansion characters. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
