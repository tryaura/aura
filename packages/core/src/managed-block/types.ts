/** A snippet parsed from an existing managed block. */
export interface ManagedSnippet {
  /** Canonical SHA-256 computed from the parsed content. */
  readonly computedHash: string;
  /** Exact text between the snippet marker lines. */
  readonly content: string;
  /** Exclusive source offset where the snippet body ends. */
  readonly contentEndOffset: number;
  /** Inclusive source offset where the snippet body starts. */
  readonly contentStartOffset: number;
  /** Exclusive source offset after the closing marker line. */
  readonly endOffset: number;
  /** One-based line containing the closing marker. */
  readonly endLine: number;
  readonly hashMatches: boolean;
  readonly id: string;
  /** One-based line containing the opening marker. */
  readonly startLine: number;
  /** Inclusive source offset at the opening marker. */
  readonly startOffset: number;
  /** Hash declared by the opening marker. */
  readonly storedHash: string;
}

/** A valid Aura block and its location in the source string. */
export interface ManagedBlock {
  /** Exclusive source offset after the outer closing marker line. */
  readonly endOffset: number;
  readonly endLine: number;
  readonly snippets: readonly ManagedSnippet[];
  /** Inclusive source offset at the outer opening marker. */
  readonly startOffset: number;
  readonly startLine: number;
  /** Exact non-protocol lines found outside snippets, in their original order. */
  readonly unmanagedContent: string;
}

/** Stable categories callers can map to repair actions. */
export type ManagedBlockProblemCode =
  | "duplicate-block"
  | "duplicate-snippet"
  | "incomplete-outer-block"
  | "incomplete-snippet"
  | "invalid-hash"
  | "invalid-snippet-content"
  | "invalid-snippet-id"
  | "malformed-marker"
  | "mismatched-snippet-end"
  | "missing-snippet"
  | "nested-block"
  | "nested-snippet"
  | "orphan-outer-end"
  | "orphan-snippet-marker"
  | "outer-end-before-snippet-end"
  | "unterminated-fence";

export interface ManagedBlockProblem {
  readonly code: ManagedBlockProblemCode;
  /** One-based source line, absent for problems in desired input. */
  readonly line?: number | undefined;
  readonly message: string;
}

/** Stable categories for source state a caller should report. */
type ManagedBlockNoteCode = "unmanaged-content" | "unterminated-fence";

/** Source state discovered alongside the main parser result. */
export interface ManagedBlockNote {
  readonly code: ManagedBlockNoteCode;
  /** One-based source line, absent when the underlying problem had no location. */
  readonly line?: number | undefined;
  readonly message: string;
}

/** Result of parsing a source string for Aura-managed content. */
export type ManagedBlockReadResult =
  | { readonly notes: readonly ManagedBlockNote[]; readonly status: "absent" }
  | {
      readonly block: ManagedBlock;
      readonly notes: readonly ManagedBlockNote[];
      readonly status: "present";
    }
  | {
      readonly notes: readonly ManagedBlockNote[];
      readonly problems: readonly ManagedBlockProblem[];
      readonly status: "invalid";
    };
