import { describe, expect, it } from "vitest";

import {
  defineCheck,
  definePlugin,
  type AuraPlugin,
  type DetectedFinding,
} from "@tryaura/aura-sdk";

import { runCli } from "./run.boundary.js";
import { appsPlugin, createCapture, distro, findingPlugin, throwingPlugin } from "./testing.js";
import { displayWidth } from "./text-width.js";

/** The rendered width of the row a subject heading opens, ANSI counted at zero columns. */
function rowWidth(text: string, label: string): number {
  return displayWidth(text.split("\n").find((line) => line.startsWith(label)) ?? "");
}

/** Two checks sharing one group, optionally with extra members and a manual second finding. */
function groupedPlugin(secondManual = false, extra = 0): AuraPlugin {
  const findingGroup = {
    description: "Resolve both related fixture problems.",
    id: "fixture-group/related",
    title: "Complete the related fixture setup",
  };
  return definePlugin({
    apiVersion: 2,
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
    apiVersion: 2,
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
    expect(capture.stdout.text).toContain("▶ acme check --fix");
    expect(capture.stdout.text).toContain("2 fixes: 1 automatic · 1 guided, previewed first");
    expect(capture.stdout.text).toContain("Complete the related fixture setup (1)");
    expect(capture.stdout.text).toContain("fixture-group/FIRST");
    // A group states the remediation once; it never collapses which findings need it.
    expect(capture.stdout.text).toContain("The first fixture is incomplete");
    expect(capture.stdout.text).toContain("The second fixture is incomplete");
    expect(capture.stdout.text).toMatch(/The first fixture is incomplete\. +automatic/u);
    expect(capture.stdout.text).toMatch(/The second fixture is incomplete\. +guided/u);
    expect(capture.stdout.text).toMatchInlineSnapshot(`
      "Acme Doctor check — action required

      2 errors · 0 warnings · 0 suggestions
      · 0 checks passed · 0 applications detected

      · Configuration
        Repository preset .aura/preset.json is present but not trusted on this machine, so it was not applied. Run acme setup to review and trust it.

      ▶ acme check --fix              2 fixes: 1 automatic · 1 guided, previewed first

      /workspace/project/first.md                                              1 error
        ✗ Complete the related fixture setup (1)                   fixture-group/FIRST
          Resolve both related fixture problems.
          ✗ The first fixture is incomplete.                                 automatic

      ~/.fixture/config.json                                                   1 error
        ✗ Complete the related fixture setup (1)                  fixture-group/SECOND
          Resolve both related fixture problems.
          ✗ The second fixture is incomplete.                                   guided
            Choose the appropriate fixture resolution.
            ~/.fixture/config.json:3

      · More
        Explain any check: acme check --explain <id>
        Expand occurrences and locations; add passed checks: acme check --verbose
        Docs: https://example.com/docs

      Result: action required (exit 0)
      "
    `);
  });

  it("lays the report out against the terminal's width, and takes 80 without one", async () => {
    const narrow = createCapture(["check"]);
    const redirected = createCapture(["check"]);
    Object.assign(narrow.stdout, { columns: 50 });

    await runCli(distro([groupedPlugin()]), narrow.runtime);
    await runCli(distro([groupedPlugin()]), redirected.runtime);

    // The pinned counts land on the edge of whatever width the stream reported.
    expect(rowWidth(narrow.stdout.text, "/workspace/project/first.md")).toBe(50);
    expect(rowWidth(redirected.stdout.text, "/workspace/project/first.md")).toBe(80);
    // Narrowing changes only the layout, never which findings the report names.
    expect(narrow.stdout.text).toContain("The first fixture is");
    expect(narrow.stdout.text).toContain("incomplete.");
    expect(narrow.stdout.text).toContain("fixture-group/FIRST");
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

  it("keeps a group recognizable when its findings land under two subjects", async () => {
    const capture = createCapture(["check"]);

    await runCli(distro([groupedPlugin(true)]), capture.runtime);

    // Both halves keep the group heading, so one problem never reads as two unrelated ones.
    expect(capture.stdout.text).toContain("first.md");
    expect(capture.stdout.text).toContain("~/.fixture/config.json");
    expect(capture.stdout.text.match(/Complete the related fixture setup \(1\)/g)).toHaveLength(2);
    expect(capture.stdout.text).toContain("The first fixture is incomplete");
    expect(capture.stdout.text).toContain("The second fixture is incomplete");
    expect(capture.stdout.text).toMatch(/The first fixture is incomplete\. +automatic/u);
    expect(capture.stdout.text).toMatch(/The second fixture is incomplete\. +manual/u);
  });

  it("caps concise occurrences within a subject and says how many are waiting", async () => {
    const capture = createCapture(["check"]);

    await runCli(distro([groupedPlugin(false, 5)]), capture.runtime);

    // The five located-nowhere extras gather under their check; the cap applies to that subject.
    expect(capture.stdout.text).toContain("Complete the related fixture setup (5)");
    expect(capture.stdout.text).toContain("+2 more occurrences");
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
    expect(capture.stdout.text).toContain("fixture-auto/AUTO · automatic");
  });

  it("closes with settled applications and keeps passed checks behind --verbose", async () => {
    const concise = createCapture(["check"]);
    const verbose = createCapture(["check", "--verbose"]);
    const plugins = [appsPlugin(), findingPlugin("info", [])];

    await runCli(distro(plugins), concise.runtime);
    await runCli(distro(plugins), verbose.runtime);

    expect(concise.stdout.text).toContain("1 check passed · 1 application detected");
    // A detected application nothing was found about is named as settled, not left absent.
    expect(concise.stdout.text).toContain("✓ Installed App 1.2.3 — no findings");
    expect(concise.stdout.text).not.toContain("✓ Passed checks (1)");
    expect(verbose.stdout.text).toContain("✓ Passed checks (1)");
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
    expect(capture.stdout.text).toContain("The first fixture is incomplete");
    expect(capture.stdout.text).not.toContain("▶ acme check --fix");
  });
});
