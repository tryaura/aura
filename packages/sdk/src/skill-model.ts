import type { FileProblem } from "./adapter.js";
import type { Scope } from "./common.js";

/** Whether Aura could read and parse a skill's root `SKILL.md`. */
export type SkillDefinitionStatus = "invalid-frontmatter" | "missing-file" | "ready" | "unreadable";

/** One relative file reference found in a skill definition. */
export interface SkillReference {
  /** Absolute target path, resolved beneath the skill root. */
  readonly path: string;
  /** Whether the referenced path existed during the workspace scan. */
  readonly valid: boolean;
}

/** Frontmatter fields whose present values were not strings. */
export type InvalidSkillFrontmatterField = "description" | "name" | "version";

/** A skill present on disk for one agent application. */
export interface InstalledSkill {
  /** The adapter that parsed this entry. */
  readonly appId: string;
  /** Description parsed from `SKILL.md`, when it is a string. */
  readonly description?: string | undefined;
  /** Whether `SKILL.md` was present and its YAML frontmatter parsed. */
  readonly definitionStatus?: SkillDefinitionStatus | undefined;
  /** Present frontmatter fields whose values had an unsupported type. */
  readonly invalidFrontmatterFields?: readonly InvalidSkillFrontmatterField[] | undefined;
  /** Source-local skill identifier. */
  readonly id: string;
  /** The name a user types to invoke the skill, when it differs from `id`. */
  readonly invocationName?: string | undefined;
  readonly name: string;
  readonly path: string;
  readonly scope: Scope;
  /** Absolute path of the entry's `SKILL.md`. */
  readonly skillFilePath?: string | undefined;
  /** Skill-directory source-file id. */
  readonly sourceId?: string | undefined;
  /** Absolute lexical target when this application entry is a symbolic link. */
  readonly symlinkTargetPath?: string | undefined;
  /** Canonical target when the symbolic link resolves; absent for a dangling link. */
  readonly symlinkResolvedPath?: string | undefined;
  readonly version?: string | undefined;
}

/** One resolved application skills directory. */
export interface ResolvedSkillDirectory {
  readonly id: string;
  readonly path: string;
  readonly scope: Scope;
}

/** One file or directory found below a shared installed skill. */
export interface SharedSkillEntry {
  readonly kind: "directory" | "file";
  readonly path: string;
}

/** A shared skill tree Aura can compare with manifest provenance. */
export interface SharedSkillState {
  /** Description parsed from `SKILL.md`, when it is a string. */
  readonly description?: string | undefined;
  /** Whether `SKILL.md` was present and its YAML frontmatter parsed. */
  readonly definitionStatus?: SkillDefinitionStatus | undefined;
  readonly entries: readonly SharedSkillEntry[];
  readonly id: string;
  /** Present frontmatter fields whose values had an unsupported type. */
  readonly invalidFrontmatterFields?: readonly InvalidSkillFrontmatterField[] | undefined;
  /** Invocation name parsed from `SKILL.md`, when it is a string. */
  readonly name?: string | undefined;
  readonly path: string;
  readonly problem?: FileProblem | undefined;
  /**
   * The one sentence naming what stopped the tree walk, when `problem` is set.
   *
   * The walk stops at the first entry it cannot resolve, so the rest of the tree — including
   * `SKILL.md` — may simply never have been reached. Anything reporting on an incomplete tree needs
   * to say what actually went wrong rather than what it failed to find.
   */
  readonly problemDetail?: string | undefined;
  /** Relative file references parsed from the skill definition. */
  readonly references?: readonly SkillReference[] | undefined;
  /** Absolute path of the root skill definition. */
  readonly skillFilePath?: string | undefined;
  readonly treeHash?: string | undefined;
  readonly version?: string | undefined;
}
