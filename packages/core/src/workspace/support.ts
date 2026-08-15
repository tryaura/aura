import type { AdapterSupport } from "@tryaura/aura-sdk";
import { coerce, satisfies, valid, validRange } from "semver";

/**
 * Whether a range is one {@link evaluateSupport} can compare against.
 *
 * A range that does not parse is an adapter bug, not a fact about the user's machine, so the
 * builder reports it separately instead of silently treating every version as unknown.
 */
export function isComparableRange(supportedRange: string): boolean {
  return validRange(supportedRange) !== null;
}

/**
 * Compares a detected application version against the range its adapter declares.
 *
 * Version gating lives here rather than in each adapter so that one policy — reporting fixes as
 * unsafe outside the supported range — applies to every plugin, including third-party ones.
 */
export function evaluateSupport(
  supportedRange: string,
  version: string | undefined,
): AdapterSupport {
  const comparable = normalizeVersion(version);

  if (comparable === undefined || !isComparableRange(supportedRange)) {
    return { status: "unknown", supportedRange, version };
  }

  return {
    status: satisfies(comparable, supportedRange) ? "supported" : "unsupported",
    supportedRange,
    version,
  };
}

/**
 * Turns a reported version into one semver can compare, or `undefined` when it cannot.
 *
 * Applications report versions loosely — `1.2`, `v1.2.3`, `2.0.0 (build 41)` — so a strict parse
 * failure falls back to coercion rather than declaring the version unknown.
 */
function normalizeVersion(version: string | undefined): string | undefined {
  if (version === undefined) {
    return undefined;
  }

  const exact = valid(version);
  if (exact !== null) {
    return exact;
  }

  return coerce(version)?.version;
}
