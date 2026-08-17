import { safe } from "./safe-text.js";

/**
 * The one line an application Aura did not find gets, wherever it is listed.
 *
 * `check` and `setup` both list absent applications, and a reader moving between them should not
 * have to work out whether two phrasings mean the same thing, so both compose the line here.
 *
 * `detectionScope` names what the adapter's probe looked at, and the caller supplies it only when
 * detection ran to completion and reported the application absent. Without one there is nothing
 * honest to add beyond the outcome, which is why the fallback says no more than "not found".
 */
export function notFoundLine(displayName: string, detectionScope: string | undefined): string {
  if (detectionScope === undefined) {
    return `${safe(displayName)} — not found`;
  }
  return `${safe(displayName)} — looked for ${safe(detectionScope)}`;
}
