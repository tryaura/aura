import type { Writable } from "node:stream";

import type { RepoSessionAggregate, SessionAnalysis } from "@tryaura/core";

import { bar, chartLabel, count, duration, percent, ratio } from "./chart.js";
import {
  compareAttention,
  hasCompactionPressure,
  hasMaterialCheckFailures,
  hasMaterialToolProblems,
  needsAttention,
  toolProblemCount,
} from "./health.js";
import { overallRows } from "./render-overall.js";
import { safe } from "../safe-text.js";

/**
 * The human sessions report.
 *
 * Leads with what the user should do something about, not with inventory: the window's totals,
 * then only the directories showing trouble (failing tools, truncated transcripts, sessions that
 * keep outgrowing the context window), then the few busiest directories for orientation. The full
 * per-directory list exists but sits behind `--verbose`; the default report names how much it
 * withheld. Shared geometry with the help screens: titles indented two spaces, rows four, no
 * boxes, no trailing periods. Recorded paths and command names are neutralized before printing.
 */
export interface RenderSessionsOptions {
  readonly days: number;
  readonly homeDir: string;
  readonly stdout: Writable;
  readonly verbose: boolean;
}

/** How many busiest directories the default report shows. */
const BUSIEST_LIMIT = 5;

/** How many attention entries the default report shows before summarizing the rest. */
const ATTENTION_LIMIT = 8;

export function renderSessionsReport(
  analysis: SessionAnalysis,
  options: RenderSessionsOptions,
): void {
  const window = options.days === 1 ? "1 day" : `${options.days} days`;
  const lines: string[] = [`Agent sessions — Codex, since ${analysis.since} (${window})`];
  if (analysis.sessions.length === 0) {
    lines.push("", `  No Codex sessions recorded since ${analysis.since}`);
    options.stdout.write(`${lines.join("\n")}\n`);
    return;
  }

  lines.push("", ...overallRows(analysis));
  lines.push(...attentionSection(analysis, options.homeDir, options.verbose));
  if (options.verbose) {
    lines.push(...projectChart("All projects", analysis.repos, options.homeDir));
  } else {
    const busiest = [...analysis.repos].sort((a, b) => b.wallClockMs - a.wallClockMs);
    lines.push(
      ...projectChart("Projects by agent time", busiest.slice(0, BUSIEST_LIMIT), options.homeDir),
      ...withheldRows(analysis.repos.length - BUSIEST_LIMIT),
    );
  }
  lines.push("", `  ${GRADE_LEGEND}`);
  options.stdout.write(`${lines.join("\n")}\n`);
}

/** What the letters mean, printed with every graded report so the scale needs no manual. */
const GRADE_LEGEND = "Grades: A great · B good · C fair · D poor · F failing";

/** Directories with something to act on, worst first. Empty when the window ran clean. */
function attentionSection(
  analysis: SessionAnalysis,
  homeDir: string,
  verbose: boolean,
): readonly string[] {
  const flagged = analysis.repos.filter(needsAttention).sort(compareAttention);
  if (flagged.length === 0) {
    return [];
  }
  const shown = verbose ? flagged : flagged.slice(0, ATTENTION_LIMIT);
  const lines = ["", "  Needs attention"];
  for (const repo of shown) {
    lines.push(`    ${projectHeading(repo, homeDir)}`);
    for (const reason of attentionReasons(repo)) {
      lines.push(`      ${reason}`);
    }
  }
  if (flagged.length > shown.length) {
    lines.push(
      `    and ${count(flagged.length - shown.length, "more project")} · --verbose lists every one`,
    );
  }
  return lines;
}

function attentionReasons(repo: RepoSessionAggregate): readonly string[] {
  const reasons: string[] = [];
  if (hasMaterialToolProblems(repo)) {
    const problemCount = toolProblemCount(repo);
    const failing = repo.outcomeCounts
      .filter(
        (entry) =>
          entry.kind === "invocation_error" ||
          entry.kind === "tool_error" ||
          entry.kind === "unknown_nonzero",
      )
      .map((entry) => `${safe(entry.label)} ×${entry.count} (${entry.kind.replace("_", " ")})`)
      .join(", ");
    const named = failing === "" ? "" : ` · outcomes: ${failing}`;
    reasons.push(
      `${problemCount} of ${count(repo.toolCalls, "tool call")} had tool problems${named}`,
    );
    const missing = repo.outcomeCounts
      .filter((entry) => entry.kind === "invocation_error")
      .map((entry) =>
        entry.label === "shell batch" ? "a command in a shell batch" : safe(entry.label),
      );
    if (missing.length > 0) {
      reasons.push(
        `${missing.join(", ")} not found (exit 127) — missing from this machine or misnamed in the instructions`,
      );
    }
  }
  if (hasMaterialCheckFailures(repo)) {
    reasons.push(
      `${count(repo.checkFailures, "check failure")} — verification ran and found code or test problems`,
    );
  }
  if (hasCompactionPressure(repo)) {
    reasons.push(
      `${count(repo.compactions, "compaction")} in ${count(repo.sessions, "session")} — sessions outgrow the context window`,
    );
  }
  if (repo.truncatedSessions > 0) {
    reasons.push(
      `${count(repo.truncatedSessions, "transcript")} truncated — counts are lower bounds`,
    );
  }
  return reasons;
}

/** One bar line per project: wall time relative to the busiest, then the numbers behind it. */
function projectChart(
  title: string,
  repos: readonly RepoSessionAggregate[],
  homeDir: string,
): readonly string[] {
  const lines = ["", `  ${title}`];
  const widest = Math.max(...repos.map((repo) => repo.wallClockMs), 1);
  for (const repo of repos) {
    const label = chartLabel(displayProject(repo.project, homeDir));
    const numbers = [
      `${duration(repo.wallClockMs)} · ${count(repo.sessions, "session")}`,
      ...(toolProblemCount(repo) > 0
        ? [`${percent(ratio(toolProblemCount(repo), repo.toolCalls))} tool problems`]
        : []),
      ...(repo.checkFailures > 0 ? [`${count(repo.checkFailures, "check failure")}`] : []),
      ...(repo.tokens.inputTokens > 0
        ? [`${percent(ratio(repo.tokens.cachedInputTokens, repo.tokens.inputTokens))} cached`]
        : []),
      ...(repo.directories > 1 ? [count(repo.directories, "directory", "directories")] : []),
    ];
    lines.push(`    ${label}  ${bar(repo.wallClockMs / widest)}  ${numbers.join(" · ")}`);
  }
  return lines;
}

/** The project's display name, with its worktree spread when it collapsed more than one. */
function projectHeading(repo: RepoSessionAggregate, homeDir: string): string {
  const name = displayProject(repo.project, homeDir);
  return repo.directories > 1
    ? `${name} · ${count(repo.directories, "directory", "directories")}`
    : name;
}

function withheldRows(hidden: number): readonly string[] {
  if (hidden <= 0) {
    return [];
  }
  return [
    "",
    `  ${count(hidden, "more project")} in the window · --verbose lists every one, --json carries full detail`,
  ];
}

/** A resolved repository name prints as-is; a path label shortens under home like any other. */
function displayProject(project: string, homeDir: string): string {
  const shortened = project.startsWith(`${homeDir}/`)
    ? `~${project.slice(homeDir.length)}`
    : project;
  return safe(shortened);
}
