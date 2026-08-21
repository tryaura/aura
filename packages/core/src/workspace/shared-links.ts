import { join, resolve } from "node:path";

import {
  SHARED_INSTRUCTIONS_TEMPLATE_TOKEN,
  type Adapter,
  type AdapterFileMap,
  type AdapterSharedLink,
  type Environment,
  type ResolvedSharedLink,
  type SharedInstructionsState,
} from "@tryaura/aura-sdk";

import type { PathContents } from "./reader.js";

const GLOBAL_PREFIX = "~/";
const SHARED_INSTRUCTIONS_SEGMENTS = Object.freeze(["agents", "AGENTS.md"]);
const SHARED_INSTRUCTIONS_HOME_REFERENCE = "~/agents/AGENTS.md";
const SHARED_LINK_KINDS = new Set(["import-line", "native-copy", "symlink"]);

/** The one adapter field a shared-link declaration can come from. */
const SLOT_NAME = "sharedLink";

/** Canonical shared-instruction path for one captured environment. */
export function sharedInstructionsPath(environment: Environment): string {
  return join(environment.homeDir, ...SHARED_INSTRUCTIONS_SEGMENTS);
}

/**
 * Returns every declarative problem in a shared-link contribution.
 *
 * The `~/` prefix is required rather than merely accepted. A declaration naming `./something` is
 * what let a home-scoped check demand a file inside whichever repository the user was standing in,
 * written with their home directory spelled out absolutely; Aura links only the home entry now, so
 * the prefix is the whole statement of where the file lives.
 */
export function sharedLinkViolations(link: AdapterSharedLink): readonly string[] {
  const violations: string[] = [];
  if (!SHARED_LINK_KINDS.has(link.kind)) {
    violations.push(`kind "${String(link.kind)}" is not supported`);
  }

  const relative =
    typeof link.entryPath === "string" && link.entryPath.startsWith(GLOBAL_PREFIX)
      ? link.entryPath.slice(GLOBAL_PREFIX.length)
      : undefined;
  if (relative === undefined) {
    violations.push(`entryPath must begin with "${GLOBAL_PREFIX}"`);
  } else if (
    relative.length === 0 ||
    relative.includes("\\") ||
    relative.includes("\0") ||
    relative
      .split("/")
      .some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    violations.push("entryPath must be a normalized portable path without traversal");
  }

  if (link.kind === "symlink") {
    if (link.lineTemplate !== undefined) {
      violations.push("symlink declarations must not provide lineTemplate");
    }
  } else if (typeof link.lineTemplate !== "string" || link.lineTemplate.length === 0) {
    violations.push(`${link.kind} declarations require lineTemplate`);
  } else if (countToken(link.lineTemplate) !== 1) {
    violations.push(
      `lineTemplate must contain exactly one ${SHARED_INSTRUCTIONS_TEMPLATE_TOKEN} token`,
    );
  } else if (link.kind === "import-line" && /[\n\r]/u.test(link.lineTemplate)) {
    // The write side recognizes an import it already added by matching the rendered line against
    // the entry file's lines. A template spanning lines matches nothing it wrote, so every run
    // would append another copy. A native-copy template is a whole file and is exempt.
    violations.push("import-line lineTemplate must be a single line");
  }

  return Object.freeze(violations);
}

/** Resolves and verifies one adapter's shared-link declaration against its read-side files. */
export function resolveAdapterSharedLink(
  adapter: Adapter,
  environment: Environment,
  files: AdapterFileMap,
): ResolvedSharedLink | undefined {
  return resolveSharedLink(adapter.sharedLink, environment, files);
}

/**
 * Resolves one declaration, naming the shared source the way a home entry can survive.
 *
 * The entry names the source through `~`, which is the same string on every machine the user owns.
 */
function resolveSharedLink(
  declaration: AdapterSharedLink | undefined,
  environment: Environment,
  files: AdapterFileMap,
): ResolvedSharedLink | undefined {
  if (declaration === undefined) {
    return undefined;
  }

  const entryPath = resolveSharedEntry(declaration, environment, files);
  if (declaration.kind === "symlink") {
    return { entryPath, kind: declaration.kind, scope: "global" };
  }

  return {
    content: declaration.lineTemplate?.replace(
      SHARED_INSTRUCTIONS_TEMPLATE_TOKEN,
      SHARED_INSTRUCTIONS_HOME_REFERENCE,
    ),
    entryPath,
    kind: declaration.kind,
    scope: "global",
  };
}

function resolveSharedEntry(
  declaration: AdapterSharedLink,
  environment: Environment,
  files: AdapterFileMap,
): string {
  const violations = sharedLinkViolations(declaration);
  if (violations.length > 0) {
    throw new Error(`declares an invalid ${SLOT_NAME}: ${violations.join("; ")}`);
  }

  const relative = declaration.entryPath.slice(GLOBAL_PREFIX.length);
  const entryPath = join(environment.homeDir, ...relative.split("/"));
  const declared = [...files.values()].some(
    (file) => resolve(file.spec.path) === resolve(entryPath) && file.spec.scope === "global",
  );
  if (!declared) {
    throw new Error(
      `declares ${SLOT_NAME} entry ${entryPath}, but its files() result did not declare that path at global scope`,
    );
  }
  return entryPath;
}

function countToken(template: string): number {
  return template.split(SHARED_INSTRUCTIONS_TEMPLATE_TOKEN).length - 1;
}

/**
 * Describes core's bounded read of the shared instruction source.
 *
 * A directory or an entry whose bytes never arrived is reported as `unsupported` rather than as
 * present-and-empty: the shared source is a file every adapter is wired to, and treating an
 * unreadable one as empty would offer to overwrite whatever is actually there.
 */
export function toSharedInstructions(
  path: string,
  contents: PathContents,
): SharedInstructionsState {
  const problem =
    contents.problem ??
    (contents.exists && (contents.isDirectory || contents.content === undefined)
      ? "unsupported"
      : undefined);
  return {
    content: contents.content,
    exists: contents.exists,
    path,
    problem,
  };
}
