import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.smoke.ts"],
    // Each case runs the compiled binary several times over, and every run pays the SDK's probe
    // budget per candidate. See the root config for why this stays well clear of that ceiling.
    testTimeout: 60_000,
  },
});
