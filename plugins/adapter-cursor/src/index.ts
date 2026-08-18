import { definePlugin } from "@tryaura/aura-sdk";

import { cursorAdapter } from "./adapter.js";

/** @public */
export {
  CURSOR_ADAPTER_ID,
  CURSOR_SOURCE_IDS,
  isConditionalCursorRule,
  readCursorMcpRuntimeStates,
  readCursorMcpStateUnavailable,
  type CursorMcpRuntimeState,
  type CursorMcpStateUnavailableReason,
} from "./contract.js";

export default definePlugin({
  adapters: [cursorAdapter],
  apiVersion: 1,
  id: "adapter-cursor",
  name: "Cursor Adapter",
  version: "0.0.0",
});
