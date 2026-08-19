import { describe, expect, it } from "vitest";

import {
  defineCheck,
  definePlugin,
  type AuraPlugin,
  type DetectedFinding,
} from "@tryaura/aura-sdk";

import { runCli } from "./run.js";
import { appsPlugin, createCapture, distro, findingPlugin, throwingPlugin } from "./testing.js";

/** Two checks sharing one group, optionally with extra members and a manual second finding. */
function groupedPlugin(secondManual = false, extra = 0): AuraPlugin {
  const findingGroup = {
    description: "Resolve both related fixture problems.",
    id: "fixture-group/related",
    title: "Complete the related fixture setup",
  };
  return definePlugin({
    apiVersion: 1,
    checks: [
      defineCheck({
        defaultSeverity: "error",
        detect: () => [
          {
            id: "first",
            locations: [{ path: "/workspace/project/first.md" }],
            message: "The first fixture is incomplete.",
          },
          ...Array.from({ length: extra }, (_unused, index) => ({
            id: `extra-${String(index)}`,
            message: `extra fixture ${String(index)}`,
          })),
        ],
        explain: "Test check.",
        findingGroup,
        fix: () => undefined,
        fixability: "auto",
        id: "fixture-group/FIRST",
        scope: "global",
        title: "First fixture is complete",
      }),
      defineCheck({
        defaultSeverity: "error",
        detect: () => [
          {
            details: "Choose the appropriate fixture resolution.",
            ...(secondManual ? { fixability: "manual" as const } : {}),
            id: "second",
            locations: [{ line: 3, path: "/fixture/home/.fixture/config.json" }],
            message: "The second fixture is incomplete.",
          },
        ],
        explain: "Test check.",
        findingGroup,
        fix: () => undefined,
        fixability: "guided",
        id: "fixture-group/SECOND",
        scope: "global",
        title: "Second fixture is complete",
      }),
    ],
    id: "fixture-group",
    name: "Fixture Group",
    version: "1.0.0",
  });
}

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

describe("action-first human check output", () => {
  it("leads with one command for automatic and guided fixes", async () => {
    const capture = createCapture(["check"]);

    expect(await runCli(distro([groupedPlugin()]), capture.runtime)).toBe(0);

    expect(capture.stdout.text).toContain("Acme Doctor check — action required");
    expect(capture.stdout.text).toContain("▶ Recommended next step");
    expect(capture.stdout.text).toContain("acme check --fix --interactive");
    expect(capture.stdout.text).toContain("2 available fixes: 1 automatic · 1 guided");
    expect(capture.stdout.text).toContain("Complete the related fixture setup (2)");
    expect(capture.stdout.text).toContain("Checks: fixture-group/FIRST, fixture-group/SECOND");
    // A group states the remediation once; it never collapses which findings need it.
    expect(capture.stdout.text).toContain("The first fixture is incomplete");
    expect(capture.stdout.text).toContain("The second fixture is incomplete");
    expect(capture.stdout.text).toMatchInlineSnapshot(`
      "Acme Doctor check — action required

      2 errors · 0 warnings · 0 suggestions
      · 0 checks passed · 0 applications detected

      · Configuration
        Repository preset .aura/preset.json is present but not trusted on this machine, so it was not applied. Run acme setup to review and trust it.

      ▶ Recommended next step
        acme check --fix --interactive
        Review 2 available fixes: 1 automatic · 1 guided.
        Aura previews every change before writing and checks your setup again afterward.

      Available fixes (2)

        ✗ Complete the related fixture setup (2)
          Resolve both related fixture problems.
          ✗ The first fixture is incomplete.
            /workspace/project/first.md
          ✗ The second fixture is incomplete.
            Choose the appropriate fixture resolution.
            ~/.fixture/config.json:3
          Checks: fixture-group/FIRST, fixture-group/SECOND

      · More
        Explain any check: acme check --explain <id>
        Expand occurrences and locations; add passed checks and applications: acme check --verbose
        Docs: https://example.com/docs

      Result: action required (exit 0)
      "
    `);
  });

  it("expands grouped occurrences and compacts project and home paths with --verbose", async () => {
    const capture = createCapture(["check", "--verbose"]);

    await runCli(distro([groupedPlugin()]), {
      ...capture.runtime,
      cwd: "/workspace/project",
    });

    expect(capture.stdout.text).toContain("The first fixture is incomplete");
    expect(capture.stdout.text).toContain("first.md");
    expect(capture.stdout.text).toContain("~/.fixture/config.json:3");
    expect(capture.stdout.text).not.toContain("--verbose");
  });

  it("keeps a group recognizable when fixability splits it across sections", async () => {
    const capture = createCapture(["check"]);

    await runCli(distro([groupedPlugin(true)]), capture.runtime);

    // Both halves keep the group heading, so one problem never reads as two unrelated ones.
    expect(capture.stdout.text).toContain("Available fixes (1)");
    expect(capture.stdout.text).toContain("Manual attention (1)");
    expect(capture.stdout.text.match(/Complete the related fixture setup \(1\)/g)).toHaveLength(2);
    expect(capture.stdout.text).toContain("The first fixture is incomplete");
    expect(capture.stdout.text).toContain("The second fixture is incomplete");
  });

  it("caps concise occurrences and says how many are waiting", async () => {
    const capture = createCapture(["check"]);

    await runCli(distro([groupedPlugin(false, 5)]), capture.runtime);

    expect(capture.stdout.text).toContain("Complete the related fixture setup (7)");
    expect(capture.stdout.text).toContain("+4 more occurrences");
    expect(capture.stdout.text).not.toContain("extra fixture 4");
  });

  it("points at --explain so a printed check id can be acted on", async () => {
    const capture = createCapture(["check"]);

    await runCli(distro([findingPlugin("warn")]), capture.runtime);

    expect(capture.stdout.text).toContain("Explain any check: acme check --explain <id>");
  });

  it("keeps ungrouped singleton findings readable and limits concise locations", async () => {
    const capture = createCapture(["check"]);

    await runCli(
      distro([
        fixablePlugin([
          {
            details: "One useful detail.",
            id: "located",
            locations: [
              { column: 7, line: 3, path: "/etc/agents/AGENTS.md" },
              { path: "/etc/agents/aura.json" },
              { path: "/etc/agents/third.json" },
            ],
            message: "The fixture needs an update.",
          },
        ]),
      ]),
      capture.runtime,
    );

    expect(capture.stdout.text).toContain("! The fixture needs an update.");
    expect(capture.stdout.text).toContain("One useful detail.");
    expect(capture.stdout.text).toContain("/etc/agents/AGENTS.md:3:7");
    expect(capture.stdout.text).toContain("+1 more location");
    expect(capture.stdout.text).toContain("Check: fixture-auto/AUTO");
  });

  it("shows application and passed-check inventory only with --verbose", async () => {
    const concise = createCapture(["check"]);
    const verbose = createCapture(["check", "--verbose"]);
    const plugins = [appsPlugin(), findingPlugin("info", [])];

    await runCli(distro(plugins), concise.runtime);
    await runCli(distro(plugins), verbose.runtime);

    expect(concise.stdout.text).toContain("1 check passed · 1 application detected");
    expect(concise.stdout.text).not.toContain("Installed App 1.2.3");
    expect(verbose.stdout.text).toContain("✓ Passed checks (1)");
    expect(verbose.stdout.text).toContain("Installed App 1.2.3 — supported");
    expect(verbose.stdout.text).toContain("· Not found (1)");
  });

  it("uses human verdicts while completed checks exit successfully", async () => {
    const clean = createCapture(["check"]);
    const warned = createCapture(["check"]);
    const errored = createCapture(["check"]);

    await runCli(distro([findingPlugin("info", [])]), clean.runtime);
    await runCli(distro([findingPlugin("warn")]), warned.runtime);
    await runCli(distro([findingPlugin("error")]), errored.runtime);

    expect(clean.stdout.text).toContain("Result: all clear (exit 0)");
    expect(warned.stdout.text).toContain("Result: attention recommended (exit 0)");
    expect(errored.stdout.text).toContain("Result: action required (exit 0)");
  });

  it("suppresses fix recommendations when a scan is incomplete", async () => {
    const capture = createCapture(["check"]);

    expect(await runCli(distro([throwingPlugin(), groupedPlugin()]), capture.runtime)).toBe(3);

    expect(capture.stdout.text).toContain("Aura will not recommend applying fixes");
    expect(capture.stdout.text).toContain("Available fixes (2)");
    expect(capture.stdout.text).not.toContain("▶ Recommended next step");
  });
});
