/**
 * Loose work-item association: issue keys and pull-request URLs a session mentioned.
 *
 * Retention is deliberately minimal — deduplicated keys and URLs only, never the text they were
 * found in, and both capped so one pathological transcript cannot grow the document. The pattern
 * is tracker-agnostic (`ABC-123` covers Jira- and Linear-style keys alike).
 */

const WORK_ITEM = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/gu;

/** Key-shaped acronyms that are never issue keys (`SHA-256`, `UTF-8`, `GPT-5`). */
const STOP_PREFIXES = new Set(["AES", "CVE", "GMT", "GPT", "ISO", "RSA", "SHA", "UTF"]);

const PULL_REQUEST_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/gu;

const WORK_ITEM_CAP = 8;
const PULL_REQUEST_CAP = 3;

/** Folds every issue key in one already-in-hand text into the session's set, up to the cap. */
export function collectWorkItems(found: Set<string>, text: string): void {
  if (found.size >= WORK_ITEM_CAP) {
    return;
  }
  for (const match of text.matchAll(WORK_ITEM)) {
    const key = match[0];
    if (STOP_PREFIXES.has(key.slice(0, key.indexOf("-")))) {
      continue;
    }
    found.add(key);
    if (found.size >= WORK_ITEM_CAP) {
      return;
    }
  }
}

/** Folds every GitHub pull-request URL in one tool output into the session's set. */
export function collectPullRequests(found: Set<string>, output: string): void {
  if (found.size >= PULL_REQUEST_CAP) {
    return;
  }
  for (const match of output.matchAll(PULL_REQUEST_URL)) {
    found.add(match[0]);
    if (found.size >= PULL_REQUEST_CAP) {
      return;
    }
  }
}
