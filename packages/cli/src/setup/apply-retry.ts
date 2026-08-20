import { applyFixPlan, FixPlanApplyError, prepareFixPlan, refreshMcpSources } from "@tryaura/core";

import type { PreparedPlan } from "./pass.js";
import { planSetup } from "./planner.js";
import type { SetupRequest } from "./setup.js";

/** How many times a raced apply is re-planned before the failure is surfaced. */
const MAX_APPLY_RETRIES = 2;

/** Everything one confirmed apply needs to survive a file changing under it. */
export interface ApplySetupPlanOptions {
  /** Test seam for the call that writes; production uses the kernel's own {@link applyFixPlan}. */
  readonly applyPlan?: typeof applyFixPlan | undefined;
  /** The exact inputs the confirmed pass planned from, so a retry re-plans the same selections. */
  readonly planInputs: Parameters<typeof planSetup>[0];
  readonly prepared: PreparedPlan;
  readonly request: SetupRequest;
}

/**
 * Applies a confirmed setup plan, absorbing the race between the confirmation and the write.
 *
 * The user pauses on "Apply this plan?" for as long as they like, and an MCP configuration file
 * another process rewrites in that pause — `~/.claude.json` under a running session — fails the
 * apply-time state check with a clean rollback. The selections have not changed, so the plan is
 * re-derived from a fresh read and applied again, bounded so a file rewritten faster than Aura can
 * plan degrades to today's failure instead of looping. A re-plan that comes back blocked or
 * conflicted rethrows the original failure: refreshing cannot help, and each attempt is
 * independent because preparation captures state anew.
 */
export async function applySetupPlan(
  options: ApplySetupPlanOptions,
): Promise<Awaited<ReturnType<typeof applyFixPlan>>> {
  const { planInputs, request } = options;
  const apply = options.applyPlan ?? applyFixPlan;
  let prepared = options.prepared;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await apply(prepared, {
        now: request.environment.now,
        stateHomeDir: request.stateHomeDir,
      });
    } catch (error) {
      if (!isRacedApply(error) || attempt === MAX_APPLY_RETRIES) {
        throw error;
      }
      const replanned = await replan(planInputs);
      if (replanned === undefined) {
        throw error;
      }
      prepared = replanned;
      request.stdout.write(
        "\nA configuration file changed while you were confirming; re-planning against its current contents.\n",
      );
    }
  }
}

/** A failed apply that changed nothing and names the one cause a fresh plan can address. */
function isRacedApply(error: unknown): boolean {
  return (
    error instanceof FixPlanApplyError &&
    error.code === "filesystem-changed" &&
    error.rollback !== "failed"
  );
}

/** The confirmed plan rebuilt over current bytes, or `undefined` when a refresh cannot help. */
async function replan(
  planInputs: ApplySetupPlanOptions["planInputs"],
): Promise<PreparedPlan | undefined> {
  await refreshMcpSources(planInputs.model);
  const outcome = planSetup(planInputs);
  if (outcome.blockers.length > 0) {
    return undefined;
  }
  const prepared = await prepareFixPlan({ model: planInputs.model, plan: outcome.plan });
  return prepared.preview.conflictedOperationCount > 0 ? undefined : prepared;
}
