import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { parseAtImports } from "./imports.js";
import { maskMarkdownCode } from "./markdown.js";
import type { SkillReference } from "./skill-model.js";

const MARKDOWN_LINK_PATTERN = /!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))/gmu;

/** Finds code-masked relative file references that stay inside one skill tree. */
export function parseSkillReferences(
  content: string,
  context: { readonly homeDir: string; readonly skillRoot: string; readonly sourcePath: string },
): readonly SkillReference[] {
  const visible = maskMarkdownCode(content);
  const candidates = [
    ...parseAtImports(visible, { homeDir: context.homeDir, sourcePath: context.sourcePath }).map(
      (link) => link.targetPath,
    ),
    ...[...visible.matchAll(MARKDOWN_LINK_PATTERN)].flatMap((match) => {
      const destination = match[1] ?? match[2];
      const local = destination === undefined ? undefined : localDestination(destination);
      return local === undefined ? [] : [resolve(dirname(context.sourcePath), local)];
    }),
  ];
  const root = resolve(context.skillRoot);
  const seen = new Set<string>();
  const references: SkillReference[] = [];
  for (const path of candidates.map((candidate) => resolve(candidate))) {
    if (!isWithin(root, path) || seen.has(path)) {
      continue;
    }
    seen.add(path);
    references.push({ path, valid: false });
  }
  return Object.freeze(references);
}

function localDestination(destination: string): string | undefined {
  const withoutFragment = destination.split(/[?#]/u)[0];
  if (
    withoutFragment === undefined ||
    withoutFragment.length === 0 ||
    withoutFragment.startsWith("~/") ||
    isAbsolute(withoutFragment) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(withoutFragment)
  ) {
    return undefined;
  }
  return withoutFragment;
}

/** Strictly below `root`: the root itself is the skill directory, never a file it references. */
function isWithin(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`);
}
