import type { Writable } from "node:stream";

import type { RepoSessionAggregate, SessionAnalysis } from "@tryaura/core";

import { reportColumns } from "../render-human-layout.js";
import { attentionFindings } from "./attention.js";
import { bar, chartLabel, count, duration, percent, ratio } from "./chart.js";
import { toolProblemCount } from "./health.js";
import { commandChart, workItemSection } from "./render-insights.js";
import { sessionSummarySections } from "./render-overall.js";
import { displayProject, wrappedRow } from "./render-row.js";
import { sourcesLabel } from "./source-label.js";
import { wrapWords } from "../text-width.js";

/**
 * The human sessions report.
 *
 * Leads with the window's health and activity, then the few busiest directories for orientation,
 * and closes with one attention finding per actionable signal (`attention.ts`). The full
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
  const label = sourcesLabel(analysis.sources);
  const lines: string[] = [
    ...wrapWords(`Agent sessions — ${label}, since ${analysis.since} (${window})`, columns),
  ];
  if (analysis.sessions.length === 0) {
    lines.push(
      "",
      ...wrappedRow(`No ${label} sessions recorded since ${analysis.since}`, "  ", columns),
    );
    options.stdout.write(`${lines.join("\n")}\n`);
    return;
  }

  const summary = sessionSummarySections(analysis, columns);
  lines.push("", ...summary.health);
  lines.push(...summary.activity, ...summary.workflow);
  lines.push(...commandChart(analysis, columns), ...workItemSection(analysis, columns));
  if (options.verbose) {
    lines.push(...projectChart("All projects", analysis.repos, options.homeDir, columns, true));
  } else {
    const busiest = [...analysis.repos].sort((a, b) => b.agentTimeMs - a.agentTimeMs);
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
  lines.push(...attentionSection(analysis, options.homeDir, options.verbose, columns));
  lines.push("", ...wrappedRow(GRADE_LEGEND, "  ", columns));
  options.stdout.write(`${lines.join("\n")}\n`);
}

/** What the letters mean, printed with every graded report so the scale needs no manual. */
const GRADE_LEGEND = "Grades: A great · B good · C fair · D poor · F failing";

/** One line per thing worth acting on, worst first. Empty when the window ran clean. */
function attentionSection(
  analysis: SessionAnalysis,
  homeDir: string,
  verbose: boolean,
  columns: number,
): readonly string[] {
  const findings = attentionFindings(analysis, homeDir);
  if (findings.length === 0) {
    return [];
  }
  const shown = verbose ? findings : findings.slice(0, ATTENTION_LIMIT);
  const lines = ["", "  Needs attention"];
  for (const finding of shown) {
    lines.push(...wrappedRow(finding, "    ", columns));
  }
  if (findings.length > shown.length) {
    lines.push(
      ...wrappedRow(
        `and ${count(findings.length - shown.length, "more finding")} · --verbose lists every one`,
        "    ",
        columns,
      ),
    );
  }
  return lines;
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
  const widest = Math.max(...repos.map((repo) => repo.agentTimeMs), 1);
  const barWidth = columns >= 60 ? 20 : 8;
  for (const repo of repos) {
    const label = chartLabel(displayProject(repo.project, homeDir));
    lines.push(
      `    ${label}  ${bar(repo.agentTimeMs / widest, barWidth)}  ${duration(repo.agentTimeMs)}`,
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
