import type { FileProblem } from "./adapter.js";
import type { Scope } from "./common.js";

/** A skill present on disk for one agent application. */
export interface InstalledSkill {
  /** The adapter that parsed this entry. */
  readonly appId: string;
  /** Source-local skill identifier. */
  readonly id: string;
  /** The name a user types to invoke the skill, when it differs from `id`. */
  readonly invocationName?: string | undefined;
  readonly name: string;
  readonly path: string;
  readonly scope: Scope;
  /** Skill-directory source-file id. */
  readonly sourceId?: string | undefined;
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
  readonly entries: readonly SharedSkillEntry[];
  readonly id: string;
  readonly path: string;
  readonly problem?: FileProblem | undefined;
  readonly treeHash?: string | undefined;
}
