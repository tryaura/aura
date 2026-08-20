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
 * Content versions are canonical semver metadata. Skills use them for reviewed revision changes;
 * snippets retain the same contribution shape even though their install-once manifest record is
 * only an ID. Refusing ambiguous spellings keeps registry behavior deterministic.
 */
export function contentVersionProblem(version: string): string | undefined {
  return canonicalSemver(version) === version
    ? undefined
    : `declares version "${version}"; expected a canonical semver version such as "1.0.0", ` +
        "because content contributions require canonical semver metadata";
}
