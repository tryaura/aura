import type { Writable } from "node:stream";

import type { RepoSessionAggregate, SessionAnalysis } from "@tryaura/core";

import { reportColumns } from "../render-human-layout.js";
import { bar, chartLabel, count, duration, percent, ratio } from "./chart.js";
import {
  compareAttention,
  hasCompactionPressure,
  hasMaterialCheckFailures,
  hasMaterialToolProblems,
  needsAttention,
  toolProblemCount,
} from "./health.js";
import { commandChart, workItemSection } from "./render-insights.js";
import { sessionSummarySections } from "./render-overall.js";
import { safe } from "../safe-text.js";
import { wrapWords } from "../text-width.js";

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
  const columns = reportColumns(options.stdout);
  const lines: string[] = [
    ...wrapWords(`Agent sessions — Codex, since ${analysis.since} (${window})`, columns),
  ];
  if (analysis.sessions.length === 0) {
    lines.push(
      "",
      ...wrappedRow(`No Codex sessions recorded since ${analysis.since}`, "  ", columns),
    );
    options.stdout.write(`${lines.join("\n")}\n`);
    return;
  }

  const summary = sessionSummarySections(analysis, columns);
  lines.push("", ...summary.health);
  lines.push(...attentionSection(analysis, options.homeDir, options.verbose, columns));
  lines.push(...summary.activity, ...summary.workflow);
  lines.push(...commandChart(analysis, columns), ...workItemSection(analysis, columns));
  if (options.verbose) {
    lines.push(...projectChart("All projects", analysis.repos, options.homeDir, columns, true));
  } else {
    const busiest = [...analysis.repos].sort((a, b) => b.wallClockMs - a.wallClockMs);
    lines.push(
      ...projectChart(
        "Projects by agent time",
        busiest.slice(0, BUSIEST_LIMIT),
        options.homeDir,
        columns,
        false,
      ),
      ...withheldRows(analysis.repos.length - BUSIEST_LIMIT, columns),
    );
  }
  lines.push("", ...wrappedRow(GRADE_LEGEND, "  ", columns));
  options.stdout.write(`${lines.join("\n")}\n`);
}

/** What the letters mean, printed with every graded report so the scale needs no manual. */
const GRADE_LEGEND = "Grades: A great · B good · C fair · D poor · F failing";

/** Directories with something to act on, worst first. Empty when the window ran clean. */
function attentionSection(
  analysis: SessionAnalysis,
  homeDir: string,
  verbose: boolean,
  columns: number,
): readonly string[] {
  const flagged = analysis.repos.filter(needsAttention).sort(compareAttention);
  if (flagged.length === 0) {
    return [];
  }
  const shown = verbose ? flagged : flagged.slice(0, ATTENTION_LIMIT);
  const lines = ["", "  Needs attention"];
  for (const repo of shown) {
    lines.push(...wrappedRow(projectHeading(repo, homeDir), "    ", columns));
    for (const reason of attentionReasons(repo, verbose)) {
      lines.push(...wrappedRow(reason.summary, "      ", columns));
      for (const detail of reason.details) {
        lines.push(...wrappedRow(detail, "        ", columns));
      }
    }
  }
  if (flagged.length > shown.length) {
    lines.push(
      ...wrappedRow(
        `and ${count(flagged.length - shown.length, "more project")} · --verbose lists every one`,
        "    ",
        columns,
      ),
    );
  }
  return lines;
}

interface AttentionReason {
  readonly details: readonly string[];
  readonly summary: string;
}

function attentionReasons(
  repo: RepoSessionAggregate,
  verbose: boolean,
): readonly AttentionReason[] {
  const reasons: AttentionReason[] = [];
  if (hasMaterialToolProblems(repo)) {
    const problemCount = toolProblemCount(repo);
    const failing = repo.outcomeCounts.filter(
      (entry) =>
        entry.kind === "invocation_error" ||
        entry.kind === "tool_error" ||
        entry.kind === "unknown_nonzero",
    );
    const shown = verbose ? failing : failing.slice(0, 3);
    const details = [
      `${count(repo.toolCalls, "tool call")} · ${percent(ratio(problemCount, repo.toolCalls))} had problems`,
      ...shown.map(
        (entry) => `${safe(entry.label)} ×${entry.count} · ${entry.kind.replaceAll("_", " ")}`,
      ),
    ];
    if (shown.length < failing.length) {
      details.push(
        `and ${count(failing.length - shown.length, "more outcome")} · --verbose lists every one`,
      );
    }
    reasons.push({
      details,
      summary: `Tool problems · ${problemCount}`,
    });
    const missing = repo.outcomeCounts
      .filter((entry) => entry.kind === "invocation_error")
      .map((entry) =>
        entry.label === "shell batch" ? "a command in a shell batch" : safe(entry.label),
      );
    if (missing.length > 0) {
      reasons.push({
        details: ["Missing from this machine or misnamed in the instructions"],
        summary: `${missing.join(", ")} not found · exit 127`,
      });
    }
  }
  if (hasMaterialCheckFailures(repo)) {
    reasons.push({
      details: ["Verification found code or test problems"],
      summary: `Check failures · ${repo.checkFailures}`,
    });
  }
  if (hasCompactionPressure(repo)) {
    reasons.push({
      details: ["Sessions outgrew the context window"],
      summary: `Compactions · ${repo.compactions} / ${repo.sessions} sessions`,
    });
  }
  if (repo.truncatedSessions > 0) {
    reasons.push({
      details: ["Counts are lower bounds"],
      summary: `Truncated transcripts · ${repo.truncatedSessions}`,
    });
  }
  return reasons;
}

/** One bar line per project: wall time relative to the busiest, then the numbers behind it. */
function projectChart(
  title: string,
  repos: readonly RepoSessionAggregate[],
  homeDir: string,
  columns: number,
  verbose: boolean,
): readonly string[] {
  const lines = ["", `  ${title}`];
  const widest = Math.max(...repos.map((repo) => repo.wallClockMs), 1);
  const barWidth = columns >= 60 ? 20 : 8;
  for (const repo of repos) {
    const label = chartLabel(displayProject(repo.project, homeDir));
    lines.push(
      `    ${label}  ${bar(repo.wallClockMs / widest, barWidth)}  ${duration(repo.wallClockMs)}`,
    );
    lines.push(...projectDetailRows(repo, columns, verbose));
  }
  return lines;
}

function projectDetailRows(
  repo: RepoSessionAggregate,
  columns: number,
  verbose: boolean,
): readonly string[] {
  const inventory = [
    count(repo.sessions, "session"),
    ...(repo.directories > 1 ? [count(repo.directories, "directory", "directories")] : []),
  ];
  const rows = [...wrappedRow(inventory.join(" · "), "      ", columns)];
  if (!verbose) {
    return rows;
  }
  if (toolProblemCount(repo) > 0) {
    rows.push(
      ...wrappedRow(
        `Tool problems · ${percent(ratio(toolProblemCount(repo), repo.toolCalls))}`,
        "      ",
        columns,
      ),
    );
  }
  if (repo.checkFailures > 0) {
    rows.push(...wrappedRow(`Check failures · ${repo.checkFailures}`, "      ", columns));
  }
  if (repo.tokens.inputTokens > 0) {
    rows.push(
      ...wrappedRow(
        `Cache hit · ${percent(ratio(repo.tokens.cachedInputTokens, repo.tokens.inputTokens))}`,
        "      ",
        columns,
      ),
    );
  }
  return rows;
}

/** The project's display name, with its worktree spread when it collapsed more than one. */
function projectHeading(repo: RepoSessionAggregate, homeDir: string): string {
  const name = displayProject(repo.project, homeDir);
  return repo.directories > 1
    ? `${name} · ${count(repo.directories, "directory", "directories")}`
    : name;
}

function withheldRows(hidden: number, columns: number): readonly string[] {
  if (hidden <= 0) {
    return [];
  }
  return [
    "",
    ...wrappedRow(
      `${count(hidden, "more project")} in the window · --verbose lists every one, --json carries full detail`,
      "  ",
      columns,
    ),
  ];
}

function wrappedRow(text: string, indent: string, columns: number): readonly string[] {
  return wrapWords(text, Math.max(1, columns - indent.length)).map((line) => `${indent}${line}`);
}

/** A resolved repository name prints as-is; a path label shortens under home like any other. */
function displayProject(project: string, homeDir: string): string {
  const shortened = project.startsWith(`${homeDir}/`)
    ? `~${project.slice(homeDir.length)}`
    : project;
  return safe(shortened);
}
