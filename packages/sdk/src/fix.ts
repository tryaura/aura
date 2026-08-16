/**
 * File modes a {@link FixPlan} may request.
 *
 * Deliberately closed. Aura writes agent configuration, which never needs to be group- or
 * world-writable, executable, setuid, or setgid, so those modes are not expressible.
 */
export type FileMode = 0o600 | 0o644 | 0o700 | 0o755;

/** Creates or replaces a file. */
export interface WriteFileOperation {
  /** Full file contents. */
  readonly content: string;
  /**
   * Permissions for a newly created file. Defaults to `0o644`.
   *
   * A file that already exists keeps the mode it has — a user who tightened permissions on their
   * own config should not have a fix loosen them again. The preview says so when the two differ,
   * so the outcome is visible rather than silent.
   *
   * No plan can opt out of that. Core enforces an exact mode on the handful of files it owns as
   * protocol, and it decides which those are by path; a plan cannot nominate one.
   */
  readonly mode?: FileMode | undefined;
  /** Absolute path to write. */
  readonly path: string;
  /** Discriminant. */
  readonly type: "write";
}

/** Deletes a file or an empty directory. */
export interface RemovePathOperation {
  /** Absolute path to remove. */
  readonly path: string;
  /** Discriminant. */
  readonly type: "remove";
}

/** Renames a file or directory. */
export interface MovePathOperation {
  /** Absolute destination path. */
  readonly destinationPath: string;
  /** Absolute source path. */
  readonly sourcePath: string;
  /** Discriminant. */
  readonly type: "move";
}

/** Creates a symbolic link. */
export interface SymlinkOperation {
  /** Absolute path of the link itself. */
  readonly path: string;
  /** Absolute path the link points at. */
  readonly target: string;
  /** Discriminant. */
  readonly type: "symlink";
}

/**
 * A change a fix may request. Discriminate on `type`.
 *
 * The union is closed: a fix cannot run a command, install a package, or make a network request.
 */
export type FileOperation =
  | MovePathOperation
  | RemovePathOperation
  | SymlinkOperation
  | WriteFileOperation;

/**
 * The remediation for one {@link Finding}, expressed as data.
 *
 * A plan describes changes; it never applies them. Aura core owns diff previews, dry runs,
 * execution, and rollback. A plan is applied whole or not at all: an operation that fails partway
 * through unwinds the ones before it.
 *
 * Every path in `operations` — including {@link SymlinkOperation.target} — must resolve inside the
 * workspace or a directory a detected adapter declared as global-scope configuration, such as
 * `~/.claude`. Aura core rejects a plan that escapes those roots via `..`, an absolute path
 * elsewhere, or an intermediate symlink, and it replaces a symbolic link at a target path rather
 * than writing through it — so a fix cannot reach `~/.ssh` or a shell profile.
 *
 * An operation the filesystem does not currently permit is reported in the preview as a conflict
 * rather than raised as an error, so a partially applicable plan can still be shown in full.
 */
export interface FixPlan {
  /** Steps a user must perform themselves, for a `guided` {@link Fixability}. */
  readonly manualSteps?: readonly string[] | undefined;
  /** Changes to apply, in order. */
  readonly operations: readonly FileOperation[];
  /** One-line description of what applying the plan does, shown before confirmation. */
  readonly summary: string;
}
