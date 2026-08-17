import type {
  AdapterCapabilities,
  AdapterImportStyle,
  AdapterInstructionLoading,
} from "@tryaura/aura-sdk";

/**
 * {@link AdapterInstructionCapabilities} with the SDK's documented defaults applied.
 *
 * `importDepthLimit` stays `undefined` for "follow chains however far they go", and `loading`
 * stays `undefined` for "not modeled" — both are meaningful answers a check branches on, so they
 * are not papered over with sentinels here.
 */
export interface ResolvedInstructionCapabilities {
  readonly importDepthLimit: number | undefined;
  readonly importStyle: AdapterImportStyle;
  readonly loading: AdapterInstructionLoading | undefined;
}

/**
 * How an application loads instruction files, with the SDK's defaults filled in.
 *
 * Reads the declaration core carries into the model from {@link AdapterCapabilities}, so a
 * third-party adapter's declaration is honored exactly like a bundled one's. An app whose adapter
 * declares nothing gets the contract's documented fallbacks.
 */
export function instructionCapabilities(app: {
  readonly capabilities?: AdapterCapabilities | undefined;
}): ResolvedInstructionCapabilities {
  const declared = app.capabilities?.instructions;
  return {
    importDepthLimit: declared?.importDepthLimit,
    importStyle: declared?.importStyle ?? "at-import",
    loading: declared?.loading,
  };
}
