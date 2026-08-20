import { dirname, join, relative, resolve } from "node:path";

import {
  SHARED_INSTRUCTIONS_TEMPLATE_TOKEN,
  type Adapter,
  type AdapterFileMap,
  type AdapterSharedLink,
  type Environment,
  type ResolvedSharedLink,
  type Scope,
  type SharedInstructionsState,
} from "@tryaura/aura-sdk";

import type { PathContents } from "./reader.js";

const GLOBAL_PREFIX = "~/";
const PROJECT_PREFIX = "./";
const SHARED_INSTRUCTIONS_SEGMENTS = Object.freeze(["agents", "AGENTS.md"]);
const SHARED_INSTRUCTIONS_HOME_REFERENCE = "~/agents/AGENTS.md";
const PROJECT_SHARED_INSTRUCTIONS_FILE = "AGENTS.md";
const SHARED_LINK_KINDS = new Set(["import-line", "native-copy", "symlink"]);

/** Which adapter field a declaration came from, and therefore where its entry is allowed to live. */
interface SharedLinkSlot {
  readonly name: string;
  readonly scope: Scope;
}

const GLOBAL_SLOT: SharedLinkSlot = Object.freeze({ name: "sharedLink", scope: "global" });
const PROJECT_SLOT: SharedLinkSlot = Object.freeze({
  name: "projectSharedLink",
  scope: "project",
});

/** Canonical shared-instruction path for one captured environment. */
export function sharedInstructionsPath(environment: Environment): string {
  return join(environment.homeDir, ...SHARED_INSTRUCTIONS_SEGMENTS);
}

/**
 * Canonical project shared-instruction path for one checkout.
 *
 * Exported because the setup wizard has to name the same file core links adapters to. Two packages
 * each spelling out `AGENTS.md` is how a link ends up pointing at a file setup never wrote.
 */
export function projectSharedInstructionsPath(
  projectRoot: string | undefined,
  cwd: string,
): string {
  return join(projectRoot ?? cwd, PROJECT_SHARED_INSTRUCTIONS_FILE);
}

/**
 * Returns every declarative problem in a shared-link contribution to the given scope.
 *
 * The prefix is checked against the slot rather than merely being one of the two: a global
 * declaration naming `./something` is what let a home-scoped check demand a file inside whichever
 * repository the user was standing in, written with their home directory spelled out absolutely.
 * Which slot an adapter fills is the whole statement of where the file lives.
 */
export function sharedLinkViolations(link: AdapterSharedLink, scope: Scope): readonly string[] {
  const violations: string[] = [];
  if (!SHARED_LINK_KINDS.has(link.kind)) {
    violations.push(`kind "${String(link.kind)}" is not supported`);
  }

  const prefix = entryPrefix(scope);
  const relative =
    typeof link.entryPath === "string" && link.entryPath.startsWith(prefix)
      ? link.entryPath.slice(prefix.length)
      : undefined;
  if (relative === undefined) {
    violations.push(`entryPath must begin with "${prefix}" at ${scope} scope`);
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
  }

  return Object.freeze(violations);
}

/** Resolves and verifies one adapter's shared-link declaration against its read-side files. */
export function resolveAdapterSharedLink(
  adapter: Adapter,
  environment: Environment,
  files: AdapterFileMap,
): ResolvedSharedLink | undefined {
  return resolveSharedLink(
    adapter.sharedLink,
    GLOBAL_SLOT,
    environment,
    files,
    () => SHARED_INSTRUCTIONS_HOME_REFERENCE,
  );
}

export function resolveAdapterProjectSharedLink(
  adapter: Adapter,
  environment: Environment,
  files: AdapterFileMap,
  projectRoot: string | undefined,
): ResolvedSharedLink | undefined {
  const target = projectSharedInstructionsPath(projectRoot, environment.cwd);
  return resolveSharedLink(
    adapter.projectSharedLink,
    PROJECT_SLOT,
    environment,
    files,
    (entryPath) => portableRelativePath(entryPath, target),
  );
}

/**
 * Resolves one declaration, naming the shared source the way its own scope can survive.
 *
 * A home entry names the source through `~`, which is the same string on every machine the user
 * owns. A project entry names it relative to itself, so the file it produces is one the whole team
 * can commit. Nothing here can write a machine-specific absolute path into a repository, because
 * the slot decides both halves at once.
 */
function resolveSharedLink(
  declaration: AdapterSharedLink | undefined,
  slot: SharedLinkSlot,
  environment: Environment,
  files: AdapterFileMap,
  targetReference: (entryPath: string) => string,
): ResolvedSharedLink | undefined {
  if (declaration === undefined) {
    return undefined;
  }

  const entryPath = resolveSharedEntry(declaration, slot, environment, files);
  if (declaration.kind === "symlink") {
    return { entryPath, kind: declaration.kind, scope: slot.scope };
  }

  return {
    content: declaration.lineTemplate?.replace(
      SHARED_INSTRUCTIONS_TEMPLATE_TOKEN,
      targetReference(entryPath),
    ),
    entryPath,
    kind: declaration.kind,
    scope: slot.scope,
  };
}

function resolveSharedEntry(
  declaration: AdapterSharedLink,
  slot: SharedLinkSlot,
  environment: Environment,
  files: AdapterFileMap,
): string {
  const violations = sharedLinkViolations(declaration, slot.scope);
  if (violations.length > 0) {
    throw new Error(`declares an invalid ${slot.name}: ${violations.join("; ")}`);
  }

  const global = slot.scope === "global";
  const relative = declaration.entryPath.slice(entryPrefix(slot.scope).length);
  const entryPath = join(global ? environment.homeDir : environment.cwd, ...relative.split("/"));
  const declared = [...files.values()].some(
    (file) => resolve(file.spec.path) === resolve(entryPath) && file.spec.scope === slot.scope,
  );
  if (!declared) {
    throw new Error(
      `declares ${slot.name} entry ${entryPath}, but its files() result did not declare that path at ${slot.scope} scope`,
    );
  }
  return entryPath;
}

function portableRelativePath(entryPath: string, targetPath: string): string {
  const path = relative(dirname(entryPath), targetPath).replaceAll("\\", "/");
  return path.startsWith(".") ? path : `./${path}`;
}

function entryPrefix(scope: Scope): string {
  return scope === "global" ? GLOBAL_PREFIX : PROJECT_PREFIX;
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
