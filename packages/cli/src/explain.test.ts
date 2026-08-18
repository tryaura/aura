import { defineCheck, definePlugin } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { runCli } from "./index.js";
import { parseCheckExplanation } from "./test-support/check-output-schema.js";
import { createCapture, distro, findingPlugin, fixtureAdapter } from "./testing.js";

describe("check --explain", () => {
  it("explains a known check without running adapters", async () => {
    let detections = 0;
    const adapterPlugin = definePlugin({
      adapters: [
        fixtureAdapter(() => {
          detections += 1;
          return { installed: false };
        }),
      ],
      apiVersion: 1,
      id: "fixture-adapter",
      name: "Fixture Adapter",
      version: "1.0.0",
    });
    const capture = createCapture(["check", "--explain", "fixture-info/INFO"]);

    expect(await runCli(distro([adapterPlugin, findingPlugin("info", [])]), capture.runtime)).toBe(
      0,
    );
    expect(detections).toBe(0);
    expect(capture.stdout.text).toContain("Acme Doctor check fixture-info/INFO");
    expect(capture.stdout.text).toContain("info check");
    expect(capture.stdout.text).toContain("Fixability: manual");
    expect(capture.stdout.text).toContain("Test check.");
    expect(capture.stderr.text).toBe("");
  });

  it("rejects unknown explanation IDs and scan-only flags", async () => {
    const unknown = createCapture(["check", "--explain", "NOPE"]);
    const detail = createCapture(["check", "--explain", "fixture-info/INFO", "--detail"]);
    const online = createCapture(["check", "--explain", "fixture-info/INFO", "--online"]);
    const plugins = [findingPlugin("info", [])];

    expect(await runCli(distro(plugins), unknown.runtime)).toBe(2);
    expect(unknown.stderr.text).toContain("unknown check ID: NOPE");
    expect(unknown.stderr.text).toContain("fixture-info/INFO");
    expect(await runCli(distro(plugins), detail.runtime)).toBe(2);
    expect(detail.stderr.text).toContain("--explain cannot be combined with --detail");
    expect(await runCli(distro(plugins), online.runtime)).toBe(2);
    expect(online.stderr.text).toContain("--explain cannot be combined with --online");
  });

  it("resolves a check ID the way it was typed", async () => {
    const capture = createCapture(["check", "--explain", "FIXTURE-INFO/info"]);

    expect(await runCli(distro([findingPlugin("info", [])]), capture.runtime)).toBe(0);
    expect(capture.stdout.text).toContain("Acme Doctor check fixture-info/INFO");
    expect(capture.stderr.text).toBe("");
  });

  it("emits one JSON document another tool can read", async () => {
    const capture = createCapture(["check", "--explain", "fixture-info/INFO", "--json"]);

    expect(await runCli(distro([findingPlugin("info", [])]), capture.runtime)).toBe(0);
    // `--json` keeps the document alone on stdout and moves everything else to stderr.
    expect(parseCheckExplanation(capture.stdout.text)).toEqual({
      explain: "Test check.",
      fixability: "manual",
      fixesApplicable: false,
      id: "fixture-info/INFO",
      kind: "check-explanation",
      schemaVersion: 1,
      scope: "global",
      severity: "info",
      title: "info check",
    });
    expect(capture.stderr.text).toBe("");
  });

  it("names the command that can apply an automatic fix", async () => {
    const capture = createCapture(["check", "--explain", "fixture-auto/AUTO"]);
    const plugin = definePlugin({
      apiVersion: 1,
      checks: [
        defineCheck({
          defaultSeverity: "warn",
          detect: () => [],
          explain: "Auto check.",
          fix: () => ({ operations: [], summary: "Nothing to do." }),
          fixability: "auto",
          id: "fixture-auto/AUTO",
          scope: "project",
          title: "auto check",
        }),
      ],
      id: "fixture-auto",
      name: "Fixture Auto",
      version: "1.0.0",
    });

    expect(await runCli(distro([plugin]), capture.runtime)).toBe(0);
    expect(capture.stdout.text).toContain("Fixability: auto");
    expect(capture.stdout.text).toContain("apply with check --fix");
  });

  it("names the interactive command for guided fixes and reports them as applicable in JSON", async () => {
    const plugin = definePlugin({
      apiVersion: 1,
      checks: [
        defineCheck({
          defaultSeverity: "warn",
          detect: () => [],
          explain: "Guided check.",
          fix: () => undefined,
          fixability: "guided",
          id: "fixture-guided/GUIDED",
          scope: "project",
          title: "guided check",
        }),
      ],
      id: "fixture-guided",
      name: "Fixture Guided",
      version: "1.0.0",
    });
    const human = createCapture(["check", "--explain", "fixture-guided/GUIDED"]);
    const json = createCapture(["check", "--explain", "fixture-guided/GUIDED", "--json"]);

    expect(await runCli(distro([plugin]), human.runtime)).toBe(0);
    expect(human.stdout.text).toContain("check --fix --interactive");
    expect(await runCli(distro([plugin]), json.runtime)).toBe(0);
    expect(parseCheckExplanation(json.stdout.text)).toMatchObject({
      fixability: "guided",
      fixesApplicable: true,
      kind: "check-explanation",
      schemaVersion: 1,
    });
  });
});
