import type { Adapter, AdapterSourceFile, AppModel, WorkspaceModel } from "@tryaura/aura-sdk";

import { forgetMcpPlans } from "./mcp-plan.js";
import { forgetMcpSecretPlans } from "./mcp-secret-plan.js";
import { createFileReader, type FileReader } from "./reader.js";
import { readSpec } from "./specs.js";

/** Re-reads one application's MCP configuration files into the map its planners read from. */
export type McpSourceRefresher = (reader: FileReader) => Promise<void>;

/**
 * Creates the refresher one adapter scan registers beside its MCP planners.
 *
 * The planners close over `files` and read it lazily, so replacing an entry here is what makes a
 * later plan render against current bytes. Only `kind: "mcp"` specs are re-read: those are the
 * files other processes rewrite while a wizard waits on the user, and the ones whose whole-file
 * preconditions turn that churn into a blocked plan.
 *
 * Re-read diagnostics are dropped rather than surfaced: a fresh read that failed leaves a
 * `problem` on the {@link AdapterSourceFile}, which planning reports as a blocker naming the path.
 */
export function createMcpSourceRefresher(
  adapter: Adapter,
  files: Map<string, AdapterSourceFile>,
  options: {
    /** Canonical directory project-scoped paths must stay inside, when one is known. */
    readonly projectBoundary: string | undefined;
    /** Canonical Aura-owned skill root that project links may deliberately bridge to. */
    readonly sharedSkillsRoot: string;
  },
): McpSourceRefresher {
  return async (reader) => {
    const targets = [...files.values()].filter((file) => file.spec.kind === "mcp");
    await Promise.all(
      targets.map(async (target) => {
        const read = await readSpec(target.spec, {
          adapter,
          projectBoundary: options.projectBoundary,
          reader,
          sharedSkillsRoot: options.sharedSkillsRoot,
        });
        files.set(read.file.spec.id, read.file);
      }),
    );
  };
}

/**
 * Refreshers for the applications in one scan, held outside the model they belong to.
 *
 * Keyed by {@link AppModel} identity for the same reason the planner registries are: the model
 * promises not to retain configuration bytes, and reaching a refresher takes this module, which
 * plugin code cannot import.
 */
const REFRESHERS = new WeakMap<AppModel, McpSourceRefresher>();

/** Associates a refresher with the app model core just built for it. */
export function rememberMcpSourceRefresher(app: AppModel, refresher: McpSourceRefresher): void {
  REFRESHERS.set(app, refresher);
}

/**
 * Re-reads every application's MCP configuration files and forgets plans built from the old bytes.
 *
 * A scan is taken once and a plan is applied later; for a file another process rewrites in that
 * gap — `~/.claude.json` carries per-session bookkeeping beside the servers Aura owns — the gap is
 * the difference between a converged write and a blocked plan. Calling this immediately before
 * planning shrinks the exposure from the wizard's whole runtime to the write itself.
 *
 * `reader` must not be a scan's caching reader, which would faithfully return the bytes this call
 * exists to replace. Memoized plans are forgotten only for the `model` instance passed; callers
 * re-planning a different projection of the same scan must pass the instance those plans were
 * computed from.
 */
export async function refreshMcpSources(
  model: WorkspaceModel,
  reader: FileReader = createFileReader(),
): Promise<void> {
  await Promise.all(model.apps.map((app) => REFRESHERS.get(app)?.(reader)));
  forgetMcpPlans(model);
  forgetMcpSecretPlans(model);
}
