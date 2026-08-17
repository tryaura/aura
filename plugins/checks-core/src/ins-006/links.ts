import { dirname, resolve, sep } from "node:path";

import type { DetectedFinding, InstructionDocument, WorkspaceModel } from "@tryaura/aura-sdk";
import { pluralize } from "@tryaura/core/pluralize";

import { structuralFindingId } from "../finding-id.js";
import { instructionCapabilities } from "../instruction-capabilities.js";
import { displayInstructionPath } from "../instruction-paths.js";
import { compareCodePoints } from "../ordering.js";

/**
 * How many link findings one instruction file may contribute before the rest are summarized.
 *
 * A document's link count is bounded only by its size, and a project instruction file arrives with
 * whatever repository the user checked out — up to ten megabytes of `@a1.md @a2.md …` is a
 * perfectly ordinary file to core and hundreds of thousands of findings to this check. Twenty is
 * already more broken references than anyone fixes in one sitting, and the summary keeps the total
 * honest.
 */
const MAX_FINDINGS_PER_SOURCE = 20;

export type FailureKind = "cycle" | "depth" | "missing" | "outside" | "unsupported";

/**
 * How each failure reads as a noun, since a summary counts problems rather than naming a kind.
 *
 * "5 further missing link problems" makes the machine token do duty as an adjective; the phrases
 * here are what the same sentence says in the user's language.
 */
const OVERFLOW_DESCRIPTIONS: Readonly<Record<FailureKind, string>> = {
  cycle: "cyclic import",
  depth: "over-long import chain",
  missing: "broken link",
  outside: "out-of-project reference",
  unsupported: "unsupported import",
};

export interface ObservedLink {
  readonly kind: InstructionDocument["links"][number]["kind"];
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly valid: boolean;
}

/** What the model says about which links are worth resolving, and which targets may be named. */
export interface LinkReporting {
  /** Documents whose `import` links no application that reads them can activate. */
  readonly inertImports: ReadonlySet<string>;
  /** Directories a target may lie under before Aura will say whether it exists. */
  readonly roots: readonly string[];
}

export function linkReporting(model: WorkspaceModel): LinkReporting {
  const supported = new Map<string, boolean>();
  for (const app of model.apps) {
    const supports = instructionCapabilities(app).importStyle !== "none";
    for (const document of app.instructionFiles) {
      const path = resolve(document.path);
      supported.set(path, (supported.get(path) ?? false) || supports);
    }
  }

  return {
    inertImports: new Set(
      [...supported.entries()].filter(([, supports]) => !supports).map(([path]) => path),
    ),
    roots: reportableRoots(model),
  };
}

/**
 * The directories Aura will resolve a project file's references against.
 *
 * A project instruction file is one the user did not write — it arrives with the repository, and
 * `@~/.ssh/id_rsa` is what a hostile checkout names instead of a second rulebook. Core probes such
 * a target without ever opening it, which is enough while `valid` stays inside the model; saying
 * out loud which of them exist would hand the repository an answer about the machine it was cloned
 * onto. So a target is only resolved when it lies in the project itself, beside an instruction file
 * some application already reads, or in the shared instruction source's own directory — the three
 * places a genuine import points at.
 */
function reportableRoots(model: WorkspaceModel): readonly string[] {
  const roots = new Set<string>([resolve(model.projectRoot ?? model.cwd)]);
  roots.add(dirname(resolve(model.sharedInstructions.path)));
  for (const document of model.instructionFiles) {
    roots.add(dirname(resolve(document.path)));
  }
  return [...roots].sort(compareCodePoints);
}

export function isWithin(target: string, roots: readonly string[]): boolean {
  return roots.some((root) => target === root || target.startsWith(`${root}${sep}`));
}

/**
 * One entry per distinct source, target, and mechanism, in a stable order.
 *
 * Two applications may model the same file, and one of them resolving the target is enough for the
 * link to work — so repeated observations merge toward valid rather than letting adapter order
 * decide.
 */
export function observedLinks(documents: readonly InstructionDocument[]): readonly ObservedLink[] {
  const links = new Map<string, ObservedLink>();
  for (const document of documents) {
    const sourcePath = resolve(document.path);
    for (const link of document.links) {
      const targetPath = resolve(link.targetPath);
      const key = `${sourcePath}\u0000${targetPath}\u0000${link.kind}`;
      const seen = links.get(key);
      links.set(key, {
        kind: link.kind,
        sourcePath,
        targetPath,
        valid: link.valid || (seen?.valid ?? false),
      });
    }
  }
  return [...links.entries()]
    .sort(([left], [right]) => compareCodePoints(left, right))
    .map(([, link]) => link);
}

/** What a caller adds to the summaries {@link perSource} writes on its behalf. */
export interface PerSourceOptions {
  /**
   * Structural identity prefixed to each overflow summary.
   *
   * A summary names only its source file, so callers that report the same file once per
   * application supply what tells those summaries apart.
   */
  readonly overflowScope?: readonly string[] | undefined;
}

/**
 * Describes each link, keeping at most {@link MAX_FINDINGS_PER_SOURCE} findings per source file.
 *
 * The links arrive grouped by source, so the overflow for one file is known by the time the next
 * begins. A summary replaces what was dropped, because a truncated list that says nothing about
 * being truncated reads as the whole story.
 *
 * Classifying is separated from describing so that nothing past the cap is ever formatted. A
 * source's link count is bounded only by its size, and building hundreds of thousands of findings
 * to keep twenty is the cost the cap exists to avoid.
 */
export function perSource(
  links: readonly ObservedLink[],
  classify: (link: ObservedLink) => FailureKind | undefined,
  describe: (link: ObservedLink, failure: FailureKind) => DetectedFinding,
  model: WorkspaceModel,
  options: PerSourceOptions = {},
): readonly DetectedFinding[] {
  const findings: DetectedFinding[] = [];
  const reported = new Map<string, number>();
  const hidden = new Map<string, Map<FailureKind, number>>();

  for (const link of links) {
    const failure = classify(link);
    if (failure === undefined) {
      continue;
    }
    const count = reported.get(link.sourcePath) ?? 0;
    if (count >= MAX_FINDINGS_PER_SOURCE) {
      const byKind = hidden.get(link.sourcePath) ?? new Map<FailureKind, number>();
      byKind.set(failure, (byKind.get(failure) ?? 0) + 1);
      hidden.set(link.sourcePath, byKind);
      continue;
    }
    reported.set(link.sourcePath, count + 1);
    findings.push(describe(link, failure));
  }

  for (const [sourcePath, byKind] of hidden) {
    for (const [failure, count] of byKind) {
      findings.push(overflowFinding(sourcePath, failure, count, model, options));
    }
  }

  return findings;
}

function overflowFinding(
  sourcePath: string,
  failure: FailureKind,
  count: number,
  model: WorkspaceModel,
  options: PerSourceOptions,
): DetectedFinding {
  return {
    details: `Aura reports the first ${String(MAX_FINDINGS_PER_SOURCE)} link problems in a file. Fix those and run \`aura check\` again to see the rest.`,
    id: structuralFindingId(failure, [...(options.overflowScope ?? []), sourcePath, "overflow"]),
    locations: [{ path: sourcePath }],
    message: `${displayInstructionPath(sourcePath, model)} has ${String(count)} further ${pluralize(count, OVERFLOW_DESCRIPTIONS[failure])} not listed.`,
    metadata: { failure, hidden: count, sourcePath },
    severity: failure === "outside" ? "info" : "warn",
  };
}
