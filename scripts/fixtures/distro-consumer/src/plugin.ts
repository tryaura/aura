import { defineCheck, definePlugin } from "@tryaura/aura-sdk";

const acmeCheck = defineCheck({
  defaultSeverity: "warn",
  detect() {
    return [
      {
        id: "configured",
        message: "The Acme distribution loaded its private plugin.",
      },
    ];
  },
  explain: "The clean-room smoke test proves private plugins load from published package APIs.",
  fixability: "manual",
  id: "acme/ACME-001",
  scope: "global",
  title: "Acme private plugin loads",
});

export const acmePlugin = definePlugin({
  apiVersion: 1,
  checks: [acmeCheck],
  id: "acme",
  name: "Acme Dev",
  version: "1.0.0",
});
