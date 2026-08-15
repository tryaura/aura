import { definePlugin } from "@tryaura/aura-sdk";

import { codexAdapter } from "./adapter.js";

export default definePlugin({
  adapters: [codexAdapter],
  apiVersion: 1,
  id: "adapter-codex",
  name: "Codex Adapter",
  version: "0.0.0",
});
