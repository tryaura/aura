import { describe, expect, it } from "vitest";

import {
  defineCheck,
  definePlugin,
  type AuraPlugin,
  type DetectedFinding,
} from "@tryaura/aura-sdk";

import { runCli } from "./run.js";
import { appsPlugin, createCapture, distro, findingPlugin } from "./testing.js";

/** A plugin with one auto-fixable check reporting the given findings. */
function fixablePlugin(findings: readonly DetectedFinding[]): AuraPlugin {
  return definePlugin({
    apiVersion: 1,
    checks: [
      defineCheck({
        defaultSeverity: "warn",
        detect: () => findings,
        explain: "Test check.",
        fix: () => undefined,
        fixability: "auto",
        id: "fixture-auto/AUTO",
        scope: "global",
        title: "Auto check",
      }),
    ],
    id: "fixture-auto",
    name: "Fixture Auto",
    version: "1.0.0",
  });
}

/** A plugin with one guided check reporting one finding. */
function guidedPlugin(): AuraPlugin {
  return definePlugin({
    apiVersion: 1,
    checks: [
      defineCheck({
        defaultSeverity: "warn",
        detect: () => [{ id: "guided-finding", message: "guided finding" }],
        explain: "Test check.",
        fix: () => undefined,
        fixability: "guided",
        id: "fixture-guided/GUIDED",
        scope: "global",
        title: "Guided check",
      }),
    ],
    id: "fixture-guided",
    name: "Fixture Guided",
    version: "1.0.0",
  });
}

describe("renderHuman through a check run", () => {
  it("tags fixable findings and reveals --fix in the next steps", async () => {
    const capture = createCapture(["check"]);

    const exitCode = await runCli(
      distro([fixablePlugin([{ id: "auto-finding", message: "auto finding" }]), guidedPlugin()]),
      capture.runtime,
    );

    expect(exitCode).toBe(1);
    expect(capture.stdout.text).toContain("[fixture-auto/AUTO] auto finding (fixable)");
    expect(capture.stdout.text).toContain("[fixture-guided/GUIDED] guided finding (guided fix)");
    expect(capture.stdout.text).toContain("· Next steps (2)");
    expect(capture.stdout.text).toContain(
      "1 finding(s) can be fixed automatically — run acme check --fix",
    );
    expect(capture.stdout.text).toContain(
      "1 finding(s) offer guided resolutions — run acme check --fix --interactive",
    );
  });

  it("renders each finding location as its own line", async () => {
    const capture = createCapture(["check"]);

    await runCli(
      distro([
        fixablePlugin([
          {
            id: "located",
            locations: [
              { column: 7, line: 3, path: "/etc/agents/AGENTS.md" },
              { path: "/etc/agents/aura.json" },
            ],
            message: "located finding",
          },
        ]),
      ]),
      capture.runtime,
    );

    expect(capture.stdout.text).toContain("    at /etc/agents/AGENTS.md:3:7");
    expect(capture.stdout.text).toContain("    at /etc/agents/aura.json");
  });

  it("lists what was inspected before what was not found", async () => {
    const capture = createCapture(["check"]);

    await runCli(distro([appsPlugin(), findingPlugin("info", [])]), capture.runtime);

    const text = capture.stdout.text;
    expect(text).toContain("· Detected (1)");
    expect(text).toContain("Installed App 1.2.3 — supported");
    expect(text).toContain("· Not found (1)");
    expect(text.indexOf("Detected (1)")).toBeLessThan(text.indexOf("Not found (1)"));
  });

  it("closes with a verdict naming the status and exit code", async () => {
    const clean = createCapture(["check"]);
    await runCli(distro([findingPlugin("info", [])]), clean.runtime);
    expect(clean.stdout.text).toContain("Status: clean (exit 0)");

    const warned = createCapture(["check"]);
    await runCli(distro([findingPlugin("warn")]), warned.runtime);
    expect(warned.stdout.text).toContain("Status: warning (exit 1)");

    const errored = createCapture(["check"]);
    await runCli(distro([findingPlugin("error")]), errored.runtime);
    expect(errored.stdout.text).toContain("Status: error (exit 2)");
  });

  it("colors severity headings and the verdict only when the terminal has color", async () => {
    const plain = createCapture(["check"]);
    await runCli(distro([findingPlugin("warn")]), plain.runtime);
    expect(plain.stdout.text).not.toContain("\u001b[");

    const colored = createCapture(["check"]);
    await runCli(distro([findingPlugin("warn")]), { ...colored.runtime, colorDepth: 8 });
    expect(colored.stdout.text).toContain("\u001b[33m! Warnings (1)\u001b[39m");
    expect(colored.stdout.text).toContain("\u001b[33mStatus: warning (exit 1)\u001b[39m");
  });

  it("keeps the JSON document free of styling regardless of color depth", async () => {
    const capture = createCapture(["check", "--json"]);

    const exitCode = await runCli(distro([findingPlugin("warn")]), {
      ...capture.runtime,
      colorDepth: 8,
    });

    expect(exitCode).toBe(1);
    expect(capture.stdout.text).not.toContain("\u001b[");
    const report: unknown = JSON.parse(capture.stdout.text);
    expect(report).toMatchObject({ kind: "check-report" });
  });
});
