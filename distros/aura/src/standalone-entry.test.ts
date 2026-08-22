import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import packageManifest from "../package.json" with { type: "json" };

const source = (path: string): Promise<string> =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");

/**
 * The two entry points, and which one may replace itself.
 *
 * Updating is gated on the runner only the compiled entry calls, so these assertions are the wiring
 * that gate depends on. A build script quietly repointed at `main.ts` would produce a binary that
 * can never update itself, while calling the standalone runner from `main.ts` would put update code
 * behind `npx` — neither shows up in a passing command.
 */
describe("standalone distribution entry", () => {
  it("compiles the standalone entry, not the package-manager one", async () => {
    const build = await source("build-binary.mjs");

    expect(build).toContain('"src/standalone-main.boundary.ts"');
    expect(build).not.toContain('"src/main.ts"');
  });

  it("keeps the npm bin pointed at the entry with no updater capability", async () => {
    expect(packageManifest.bin).toEqual({ aura: "./dist/main.js" });

    const main = await source("src/main.ts");
    expect(main).not.toContain("update");
  });

  it("uses the standalone runner only from the compiled entry", async () => {
    const standalone = await source("src/standalone-main.boundary.ts");

    expect(standalone).toContain("AURA_UPDATES");
    expect(standalone).toContain("runStandaloneCli");
  });

  it("points the official source at this repository without an authentication variable", async () => {
    const official = await source("src/update/official-source.ts");

    expect(official).toContain('owner: "tryaura"');
    expect(official).toContain('repository: "aura"');
    // No token variable: public release assets download unauthenticated, so there is nothing a
    // hostile environment could make the official binary send.
    expect(official).not.toContain("tokenEnvironmentVariable");
  });
});
