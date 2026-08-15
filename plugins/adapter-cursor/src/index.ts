import { definePlugin } from "@tryaura/aura-sdk";

import { cursorAdapter } from "./adapter.js";

export default definePlugin({
  adapters: [cursorAdapter],
  apiVersion: 1,
  id: "adapter-cursor",
  name: "Cursor Adapter",
  version: "0.0.0",
});
