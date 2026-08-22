import { createSeedBuilder } from "@tryaura/aura-testkit";
import { describe, expect, it } from "vitest";

import { runCompiled } from "./binary-test-support.js";

/**
 * What the shipped executable must never do at startup.
 *
 * The updater runs inside `runCli`, before the requested command, so a regression in its gate is a
 * regression in every command. These cases pin the two properties a non-interactive run depends
 * on: nothing is said, and nothing waits on a network the run never asked to touch.
 */
describe("compiled Aura startup updates", () => {
  it("says nothing and adds no latency to a piped run", async () => {
    await using seed = await createSeedBuilder().build();
    const args = ["check", "--home", seed.homeDir, "--path", seed.pathDir];

    const started = performance.now();
    const run = await runCompiled(seed, args);

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).not.toContain("Updating");
    // A run that reached the network would be paying a request timeout here, not a scan.
    expect(performance.now() - started).toBeLessThan(30_000);
  });

  it.each([
    { label: "CI", variables: { CI: "true" } },
    { label: "the disable variable", variables: { AURA_UPDATE: "off" } },
  ])("stays quiet when $label is set", async ({ variables }) => {
    await using seed = await createSeedBuilder().build();

    const run = await runCompiled(
      seed,
      ["check", "--home", seed.homeDir, "--path", seed.pathDir],
      variables,
    );

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe("");
  });

  it("keeps --version byte-stable", async () => {
    await using seed = await createSeedBuilder().build();

    const run = await runCompiled(seed, ["--version"], { NO_COLOR: "1" });

    expect(run.stderr).toBe("");
    expect(run.stdout).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+\n$/u);
  });
});
