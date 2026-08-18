import { Buffer } from "node:buffer";

import type {
  Adapter,
  AdapterFileMap,
  AppModel,
  FixPlan,
  McpSecretSighting,
  WorkspaceModel,
  WriteFileOperation,
} from "@tryaura/aura-sdk";

import { MAX_MUTABLE_FILE_BYTES } from "../fix-plan/limits.js";
import { mcpSecretRedactor, rememberWriteRedactor } from "../fix-plan/write-redaction.js";
import { targetPrecondition, targetRefusal } from "./mcp-convergence.js";

interface AppMcpSecretPlanner {
  readonly plan: (sourceId: string) => FixPlan | undefined;
  readonly supports: (sighting: McpSecretSighting) => boolean;
}

const PLANNERS = new WeakMap<AppModel, AppMcpSecretPlanner>();
const PLANS = new WeakMap<WorkspaceModel, Map<string, FixPlan | undefined>>();

/** Captures raw MCP bytes for remediation behind the same private boundary as convergence. */
export function createAppMcpSecretPlanner(
  adapter: Adapter,
  files: AdapterFileMap,
  sightings: readonly McpSecretSighting[],
): AppMcpSecretPlanner | undefined {
  const transform = adapter.mcpSecrets;
  if (transform === undefined) {
    return undefined;
  }
  return {
    // fallow-ignore-next-line complexity -- every refusal keeps raw MCP bytes behind this planner boundary.
    plan: (sourceId) => {
      const target = files.get(sourceId);
      const sourceSightings = sightings.filter((sighting) => sighting.sourceId === sourceId);
      const supported = sourceSightings.filter(transform.supports);
      if (
        target === undefined ||
        target.spec.kind !== "mcp" ||
        target.content === undefined ||
        targetRefusal(target) !== undefined ||
        supported.length === 0
      ) {
        return undefined;
      }

      let rewritten: ReturnType<typeof transform.rewrite>;
      try {
        rewritten = transform.rewrite({ content: target.content, sightings: supported });
      } catch {
        return undefined;
      }
      if ("refusal" in rewritten || rewritten.rewrittenFields.length !== supported.length) {
        return undefined;
      }
      if (Buffer.byteLength(rewritten.content, "utf8") > MAX_MUTABLE_FILE_BYTES) {
        return undefined;
      }

      const operation: WriteFileOperation = {
        content: rewritten.content,
        mode: target.spec.scope === "global" ? 0o600 : 0o644,
        path: target.spec.path,
        precondition: targetPrecondition(target),
        type: "write",
      };
      rememberWriteRedactor(operation, mcpSecretRedactor(transform, sourceSightings));
      return {
        manualSteps: remediationSteps(target.spec.path, supported),
        operations: [operation],
        summary: `Replace inline MCP credentials in ${target.spec.path} with environment references.`,
      };
    },
    supports: transform.supports,
  };
}

/** Associates a private planner with the app model that exposes only safe sightings. */
export function rememberMcpSecretPlanner(app: AppModel, planner: AppMcpSecretPlanner): void {
  PLANNERS.set(app, planner);
}

/**
 * Whether this occurrence has a behavior-preserving adapter rewrite that a plan can actually carry.
 *
 * `supports` only reads the locator's shape, so it answers "could this kind of field be rewritten",
 * not "was this one". Planning is what discovers that the document is spelled in a form the writer
 * cannot edit, and a finding that advertises a guided fix the planner then declines to produce is
 * a dead end for the user. The plan is memoized, so asking it here costs nothing.
 */
export function canPlanMcpSecretRemediation(
  model: WorkspaceModel,
  sighting: McpSecretSighting,
): boolean {
  const app = model.apps.find((candidate) => candidate.adapterId === sighting.appId);
  const planner = app === undefined ? undefined : PLANNERS.get(app);
  if (planner?.supports(sighting) !== true) {
    return false;
  }
  return planMcpSecretRemediation(model, sighting) !== undefined;
}

/** Builds the one whole-file plan shared by every representable sighting in a source file. */
export function planMcpSecretRemediation(
  model: WorkspaceModel,
  sighting: McpSecretSighting,
): FixPlan | undefined {
  const key = `${sighting.appId}:${sighting.sourceId}`;
  const memo = PLANS.get(model) ?? new Map<string, FixPlan | undefined>();
  PLANS.set(model, memo);
  if (memo.has(key)) {
    return memo.get(key);
  }
  const app = model.apps.find((candidate) => candidate.adapterId === sighting.appId);
  const planner = app === undefined ? undefined : PLANNERS.get(app);
  const plan = planner?.plan(sighting.sourceId);
  memo.set(key, plan);
  return plan;
}

/**
 * What the user has to do around the rewrite, in the order the rewrite makes them possible.
 *
 * Rotation leads the list because moving a credential out of the file does not undo where it has
 * already been. A value that sat inline in configuration is a value that may have reached source
 * control, a shell history, a log, or a copied snippet — which is the reason this check exists, and
 * the reason the same value put behind an environment reference is still the wrong value to keep.
 */
function remediationSteps(
  path: string,
  sightings: readonly McpSecretSighting[],
): readonly string[] {
  const copies = sightings.map(
    (sighting) =>
      `Copy the current value for ${sighting.serverName}.${sighting.field} from ${path} now; Aura will replace it with ${sighting.suggestedEnvName}.`,
  );
  const exports = [...new Set(sightings.map((sighting) => sighting.suggestedEnvName))]
    .sort()
    .map((name) => `Run \`export ${name}=…\` in the environment that starts the MCP client.`);
  return [
    ...copies,
    ...exports,
    "Rotate each credential at its issuer: an inline value may already have been copied elsewhere.",
    "Run `aura check` again.",
  ];
}
