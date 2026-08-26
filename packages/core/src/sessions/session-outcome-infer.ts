import type { SessionOutcomeInference, SessionTurn } from "./session-detail-metrics.js";

/**
 * Infers how a session ended from how its last turn closed.
 *
 * This is inference, never ground truth: transcripts record no explicit "the task is done"
 * marker, so the result is labeled with a confidence and consumers must treat it as a lead.
 */
export function inferSessionOutcome(
  turns: readonly SessionTurn[],
  interventions: number,
  pullRequests: number,
): SessionOutcomeInference | undefined {
  const last = turns.at(-1);
  if (last === undefined) {
    return undefined;
  }
  if (last.closed === "completed") {
    return {
      // A pull request left behind is strong evidence the work actually concluded.
      confidence: pullRequests > 0 ? "high" : "medium",
      status: interventions === 0 ? "completed_autonomously" : "completed_with_help",
    };
  }
  return {
    // A log that just stops may be a crash, not an abandonment, so it stays low confidence.
    confidence: last.closed === "aborted" ? "medium" : "low",
    status: "abandoned",
  };
}
