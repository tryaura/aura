import { definePlugin } from "@tryaura/aura-sdk";

import { claudeCodeAdapter } from "./adapter.js";

export { CLAUDE_CODE_ADAPTER_ID, readClaudePermissionMode } from "./contract.js";

export default definePlugin({
  adapters: [claudeCodeAdapter],
  apiVersion: 1,
  id: "adapter-claude-code",
  name: "Claude Code Adapter",
  version: "0.0.0",
});
