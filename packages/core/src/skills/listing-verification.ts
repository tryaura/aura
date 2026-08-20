/** Advisory background verification for directory rows whose source may have stopped publishing. */
export interface DirectorySkillVerification {
  /** Whether the repository definitely lacks this skill's root definition. */
  readonly isMissing: (skillId: string) => boolean;
  /** Resolves after every repository has either verified or fallen back to trusting the feed. */
  readonly settled: Promise<void>;
  /** Repaints subscribers as repository results land; state before subscription stays queryable. */
  readonly subscribe: (listener: () => void) => () => void;
}
