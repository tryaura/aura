import { definePlugin } from "@tryaura/aura-sdk";

import { codexAdapter } from "./adapter.js";

export { CODEX_ADAPTER_ID, CODEX_SOURCE_IDS, readCodexProjectTrust } from "./contract.js";
export type { ProjectTrust } from "./contract.js";

export default definePlugin({
  adapters: [codexAdapter],
  apiVersion: 2,
  id: "adapter-codex",
  name: "Codex Adapter",
  version: "0.0.0",
});
