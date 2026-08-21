import { definePlugin } from "@tryaura/aura-sdk";

import { claudeCodeAdapter } from "./adapter.js";

/** @public */
export {
  CLAUDE_CODE_ADAPTER_ID,
  CLAUDE_CODE_SOURCE_IDS,
  CLAUDE_PERMISSIONS_KEY,
  readClaudePermissionMode,
} from "./contract.js";
/** @public */
export type { ClaudePermissionMode } from "./contract.js";

export default definePlugin({
  adapters: [claudeCodeAdapter],
  apiVersion: 2,
  id: "adapter-claude-code",
  name: "Claude Code Adapter",
  version: "0.0.0",
});
