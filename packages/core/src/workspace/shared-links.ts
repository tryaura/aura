import { join, resolve } from "node:path";

import {
  SHARED_INSTRUCTIONS_TEMPLATE_TOKEN,
  type Adapter,
  type AdapterFileMap,
  type AdapterSharedLink,
  type Environment,
  type ResolvedSharedLink,
  type Scope,
} from "@tryaura/aura-sdk";

const GLOBAL_PREFIX = "~/";
const PROJECT_PREFIX = "./";
const SHARED_INSTRUCTIONS_SEGMENTS = Object.freeze(["agents", "AGENTS.md"]);
const SHARED_INSTRUCTIONS_HOME_REFERENCE = "~/agents/AGENTS.md";
const SHARED_LINK_KINDS = new Set(["import-line", "native-copy", "symlink"]);

/** Canonical shared-instruction path for one captured environment. */
export function sharedInstructionsPath(environment: Environment): string {
  return join(environment.homeDir, ...SHARED_INSTRUCTIONS_SEGMENTS);
}

/** Returns every declarative problem in a shared-link contribution. */
export function sharedLinkViolations(link: AdapterSharedLink): readonly string[] {
  const violations: string[] = [];
  if (!SHARED_LINK_KINDS.has(link.kind)) {
    violations.push(`kind "${String(link.kind)}" is not supported`);
  }

  const relative =
    typeof link.entryPath === "string" ? relativeEntryPath(link.entryPath) : undefined;
  if (relative === undefined) {
    violations.push('entryPath must begin with "~/" or "./"');
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
  const declaration = adapter.sharedLink;
  if (declaration === undefined) {
    return undefined;
  }

  const violations = sharedLinkViolations(declaration);
  if (violations.length > 0) {
    throw new Error(`declares an invalid sharedLink: ${violations.join("; ")}`);
  }

  const global = declaration.entryPath.startsWith(GLOBAL_PREFIX);
  const relative = relativeEntryPath(declaration.entryPath);
  if (relative === undefined) {
    throw new Error("declares an invalid sharedLink entryPath");
  }
  const entryPath = join(global ? environment.homeDir : environment.cwd, ...relative.split("/"));
  const expectedScope: Scope = global ? "global" : "project";
  const declared = [...files.values()].some(
    (file) => resolve(file.spec.path) === resolve(entryPath) && file.spec.scope === expectedScope,
  );
  if (!declared) {
    throw new Error(
      `declares sharedLink entry ${entryPath}, but its files() result did not declare that path at ${expectedScope} scope`,
    );
  }

  if (declaration.kind === "symlink") {
    return { entryPath, kind: declaration.kind, scope: expectedScope };
  }

  // A global entry can name the source portably; a project entry cannot, because no agent
  // application expands `~` out of a file inside a checked-out repository. See ResolvedSharedLink.
  const targetReference = global
    ? SHARED_INSTRUCTIONS_HOME_REFERENCE
    : sharedInstructionsPath(environment);
  return {
    content: declaration.lineTemplate?.replace(SHARED_INSTRUCTIONS_TEMPLATE_TOKEN, targetReference),
    entryPath,
    kind: declaration.kind,
    scope: expectedScope,
  };
}

function relativeEntryPath(entryPath: string): string | undefined {
  if (entryPath.startsWith(GLOBAL_PREFIX) || entryPath.startsWith(PROJECT_PREFIX)) {
    return entryPath.slice(2);
  }
  return undefined;
}

function countToken(template: string): number {
  return template.split(SHARED_INSTRUCTIONS_TEMPLATE_TOKEN).length - 1;
}
