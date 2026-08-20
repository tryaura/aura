import {
  advanceMarkdownFence,
  splitSourceLines,
  type MarkdownFence,
  type SourceLine,
} from "@tryaura/aura-sdk";

/**
 * Line splitting and CommonMark fence tracking are shared with plugins that maintain their own
 * managed blocks — and with the SDK's own Markdown masking — so they live in the SDK. One fence
 * tracker means the legacy managed-block parser and the code masker cannot
 * disagree about whether a ````-opened block is closed by a ``` line.
 */
export { advanceMarkdownFence, splitSourceLines };
export type { MarkdownFence, SourceLine };
