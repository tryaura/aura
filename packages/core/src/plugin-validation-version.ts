import { parse as parseSemver } from "semver";

/**
 * A version's canonical rendering, or `undefined` when it is not semver at all.
 *
 * Parsing alone is too weak for an identity field: `semver` also accepts a leading `v` and
 * surrounding whitespace, so a version declared as "v1.0.0" or "1.0.0\n" would pass and then be
 * carried around raw. Requiring the declaration to equal its canonical form refuses those while
 * still accepting "1.2.3-rc.1+build.5" as written — build metadata has to be rebuilt by hand
 * because `valid()` drops it.
 */
export function canonicalSemver(version: string): string | undefined {
  const parsed = parseSemver(version);
  if (parsed === null) {
    return undefined;
  }
  return parsed.build.length === 0 ? parsed.version : `${parsed.version}+${parsed.build.join(".")}`;
}

/**
 * Why a content revision could never be compared to a recorded one, or `undefined` when it can.
 *
 * Managed snippets and skills are held at their recorded revision until a newer one is reviewed,
 * and "newer" is a semver comparison. A version semver cannot order therefore has no upgrade path
 * at all: setup would never offer it and MGD-002 would never report it, so the content would sit
 * frozen with nothing on screen explaining why. Refusing it at registry build is what keeps that
 * dead end out of a user's manifest, enforcing the SDK's documented "semver version of the content
 * itself" rather than trusting it.
 */
export function contentVersionProblem(version: string): string | undefined {
  return canonicalSemver(version) === version
    ? undefined
    : `declares version "${version}"; expected a canonical semver version such as "1.0.0", ` +
        "because managed content is held at its recorded revision until a newer one is reviewed";
}
