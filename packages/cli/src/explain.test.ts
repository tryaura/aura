import { defineCheck, definePlugin } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { runCli } from "./index.js";
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

  it("rejects unknown explanation IDs and --detail", async () => {
    const unknown = createCapture(["check", "--explain", "NOPE"]);
    const detail = createCapture(["check", "--explain", "fixture-info/INFO", "--detail"]);
    const plugins = [findingPlugin("info", [])];

    expect(await runCli(distro(plugins), unknown.runtime)).toBe(2);
    expect(unknown.stderr.text).toContain("unknown check ID: NOPE");
    expect(unknown.stderr.text).toContain("fixture-info/INFO");
    expect(await runCli(distro(plugins), detail.runtime)).toBe(2);
    expect(detail.stderr.text).toContain("--explain cannot be combined with --detail");
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
    expect(JSON.parse(capture.stdout.text)).toEqual({
      explain: "Test check.",
      fixability: "manual",
      fixesApplicable: false,
      id: "fixture-info/INFO",
      scope: "global",
      severity: "info",
      title: "info check",
    });
    expect(capture.stderr.text).toBe("");
  });

  it("does not promise a fix no command can apply", async () => {
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
    expect(capture.stdout.text).toContain("Applying fixes is not available in this build");
  });
});
