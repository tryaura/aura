import { createHash } from "node:crypto";
import { dirname, resolve, sep } from "node:path";

import type { DetectedFinding, InstructionDocument, WorkspaceModel } from "@tryaura/aura-sdk";
import { pluralize } from "@tryaura/core/pluralize";

import { displayInstructionPath } from "../instruction-paths.js";

/** Which applications activate an `@` import in a file they read, and which read it as prose. */
export const IMPORT_SUPPORT: ReadonlyMap<string, boolean> = new Map([
  ["claude-code", true],
  ["codex", false],
  ["cursor", true],
]);

/**
 * How many import hops each application follows before it stops loading.
 *
 * Read by every check that reasons about which files an application ends up with, so that they
 * cannot disagree about where a chain stops. Applications absent from the map follow chains as far
 * as they go.
 */
export const DEPTH_LIMITS: ReadonlyMap<string, number> = new Map([["claude-code", 5]]);

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
    const supports = IMPORT_SUPPORT.get(app.adapterId) !== false;
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
  return [...roots].sort((left, right) => left.localeCompare(right));
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
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, link]) => link);
}

/**
 * Describes each link, keeping at most {@link MAX_FINDINGS_PER_SOURCE} findings per source file.
 *
 * The links arrive grouped by source, so the overflow for one file is known by the time the next
 * begins. A summary replaces what was dropped, because a truncated list that says nothing about
 * being truncated reads as the whole story.
 */
export function perSource(
  links: readonly ObservedLink[],
  describe: (link: ObservedLink) => DetectedFinding | undefined,
  overflowKind: FailureKind,
  model: WorkspaceModel,
): readonly DetectedFinding[] {
  const findings: DetectedFinding[] = [];
  const reported = new Map<string, number>();
  const hidden = new Map<string, number>();

  for (const link of links) {
    const finding = describe(link);
    if (finding === undefined) {
      continue;
    }
    const count = reported.get(link.sourcePath) ?? 0;
    if (count >= MAX_FINDINGS_PER_SOURCE) {
      hidden.set(link.sourcePath, (hidden.get(link.sourcePath) ?? 0) + 1);
      continue;
    }
    reported.set(link.sourcePath, count + 1);
    findings.push(finding);
  }

  for (const [sourcePath, count] of hidden) {
    findings.push({
      details: `Aura reports the first ${String(MAX_FINDINGS_PER_SOURCE)} link problems in a file. Fix those and run \`aura check\` again to see the rest.`,
      id: structuralId(overflowKind, [sourcePath, "overflow"]),
      locations: [{ path: sourcePath }],
      message: `${displayInstructionPath(sourcePath, model)} has ${String(count)} further link ${pluralize(count, "problem")} not listed.`,
      metadata: { failure: overflowKind, hidden: count, sourcePath },
      severity: "warn",
    });
  }

  return findings;
}

export function structuralId(kind: FailureKind, parts: readonly string[]): string {
  const hash = createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);
  return `${kind}:${hash}`;
}
