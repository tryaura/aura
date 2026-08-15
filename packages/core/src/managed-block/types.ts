/** A snippet Aura should place in the managed block. Input order is preserved. */
export interface DesiredManagedSnippet {
  readonly content: string;
  readonly id: string;
}

/** A snippet parsed from an existing managed block. */
export interface ManagedSnippet {
  /** Canonical SHA-256 computed from the parsed content. */
  readonly computedHash: string;
  /** Exact text between the snippet marker lines. */
  readonly content: string;
  /** One-based line containing the closing marker. */
  readonly endLine: number;
  readonly hashMatches: boolean;
  readonly id: string;
  /** One-based line containing the opening marker. */
  readonly startLine: number;
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
  | "nested-block"
  | "nested-snippet"
  | "orphan-outer-end"
  | "orphan-snippet-marker"
  | "outer-end-before-snippet-end";

export interface ManagedBlockProblem {
  readonly code: ManagedBlockProblemCode;
  /** One-based source line, absent for problems in desired input. */
  readonly line?: number | undefined;
  readonly message: string;
}

/** Stable categories for state a caller should report but that never blocks reconciliation. */
type ManagedBlockNoteCode =
  | "overwritten-snippet"
  | "repaired-invalid-block"
  | "unmanaged-content"
  | "unterminated-fence";

/** Non-fatal source state reconciliation can preserve and repair automatically. */
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

/** How reconciliation should treat a source string it cannot parse. */
export interface ManagedBlockReconcileOptions {
  /**
   * `"fail"` (the default) returns the source untouched so a damaged file is never overwritten.
   * `"repair"` strips every protocol marker, keeps the handwritten text, and rebuilds the block —
   * the escape hatch for a file that would otherwise stay unmanageable until edited by hand.
   */
  readonly onInvalid?: "fail" | "repair";
}

/** Result of reconciling a source string with a complete desired snippet set. */
export type ManagedBlockWriteResult =
  | {
      readonly content: string;
      readonly notes: readonly ManagedBlockNote[];
      readonly status: "unchanged";
    }
  | {
      readonly content: string;
      readonly notes: readonly ManagedBlockNote[];
      readonly status: "updated";
    }
  | {
      readonly content: string;
      readonly notes: readonly ManagedBlockNote[];
      readonly problems: readonly ManagedBlockProblem[];
      readonly status: "invalid";
    };
