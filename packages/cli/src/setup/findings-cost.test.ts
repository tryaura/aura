import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPluginRegistry } from "@tryaura/core";
import { defineCheck, definePlugin, type AuraPlugin } from "@tryaura/aura-sdk";

import { runSetup } from "./setup.js";
import { instructionsStep } from "./steps/instructions.js";
import { snippetsStep } from "./steps/snippets.js";
import { cleanupFixtures, createFixture } from "./testing.js";

afterEach(cleanupFixtures);

/*
 * Findings cost a full check pass, and the duplicate scan among the checks is quadratic in the
 * paragraphs it compares. Only the instructions step reads them, so a run that did not select that
 * step must not pay for the scan — `setup --add snippet` is the case this protects.
 */
describe("what a setup run pays for findings", () => {
  it("runs the checks once when no selected step reads findings", async () => {
    const fixture = await createFixture();
    let detections = 0;
    await mkdir(join(fixture.homeDir, "agents"));
    await writeFile(join(fixture.homeDir, "agents", "AGENTS.md"), "# Shared\n", "utf8");
    const registry = createPluginRegistry([countingPlugin(() => (detections += 1))]);

    await expect(runSetup({ ...fixture.request(registry), steps: [snippetsStep] })).resolves.toBe(
      0,
    );

    // Once, for "end on green" — not twice.
    expect(detections).toBe(1);
  });

  it("runs the checks twice when a selected step reads findings", async () => {
    const fixture = await createFixture();
    let detections = 0;
    const registry = createPluginRegistry([countingPlugin(() => (detections += 1))]);

    await expect(
      runSetup({ ...fixture.request(registry), steps: [instructionsStep] }),
    ).resolves.toBe(0);

    expect(detections).toBe(2);
  });
});

/** An always-passing check that records how many times a run asked it to detect. */
function countingPlugin(onDetect: () => void): AuraPlugin {
  return definePlugin({
    apiVersion: 1,
    checks: [
      defineCheck({
        defaultSeverity: "info",
        detect: () => {
          onDetect();
          return [];
        },
        explain: "Counts detect calls.",
        fixability: "manual",
        id: "fixture-counting/COUNT",
        scope: "global",
        title: "Counting check",
      }),
    ],
    id: "fixture-counting",
    name: "Fixture counting",
    version: "1.0.0",
  });
}
