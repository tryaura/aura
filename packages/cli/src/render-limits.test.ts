import { describe, expect, it } from "vitest";

import { runCli } from "./run.boundary.js";
import { appsPlugin, createCapture, distro, findingPlugin } from "./testing.js";
import { parseCheckReport } from "./test-support/check-output-schema.js";

describe("human report safety limits", () => {
  it("caps findings severity-first while leaving JSON lossless", async () => {
    const informational = Array.from({ length: 100 }, (_unused, index) => ({
      id: `info-${String(index)}`,
      message: `info occurrence ${String(index)}`,
    }));
    const errors = Array.from({ length: 2 }, (_unused, index) => ({
      id: `error-${String(index)}`,
      message: `error occurrence ${String(index)}`,
    }));
    const plugins = [findingPlugin("info", informational), findingPlugin("error", errors)];
    const human = createCapture(["check", "--verbose"]);
    const json = createCapture(["check", "--json"]);

    await runCli(distro(plugins), human.runtime);
    await runCli(distro(plugins), json.runtime);

    expect(human.stdout.text).toContain("error occurrence 0");
    expect(human.stdout.text).toContain("info occurrence 97");
    expect(human.stdout.text).not.toContain("info occurrence 98");
    expect(human.stdout.text).toContain("… and 2 more findings not shown");
    expect(human.stdout.text).toContain(
      "Show every finding without human output limits: acme check --json",
    );
    // The truncated subject states both numbers; the untruncated one still states only its own.
    expect(human.stdout.text).toContain("98 of 100 suggestions");
    expect(human.stdout.text).toContain("2 errors");
    expect(parseCheckReport(json.stdout.text).findings).toHaveLength(102);
  });

  it("does not call an application settled when all of its findings are beyond the ceiling", async () => {
    const errors = Array.from({ length: 100 }, (_unused, index) => ({
      id: `error-${String(index)}`,
      message: `error occurrence ${String(index)}`,
    }));
    const hiddenAppFinding = {
      id: "hidden-app-finding",
      message: "The installed application needs attention.",
      metadata: { appId: "installed-app" },
    };
    const capture = createCapture(["check"]);

    await runCli(
      distro([
        appsPlugin(),
        findingPlugin("error", errors),
        findingPlugin("info", [hiddenAppFinding]),
      ]),
      capture.runtime,
    );

    expect(capture.stdout.text).toContain("… and 1 more finding not shown");
    expect(capture.stdout.text).not.toContain("Installed App 1.2.3 — no findings");
  });

  it("caps verbose locations and reports the omitted tail", async () => {
    const capture = createCapture(["check", "--verbose"]);
    const locations = Array.from({ length: 102 }, (_unused, index) => ({
      path: `/workspace/project/location-${String(index)}.md`,
    }));

    await runCli(
      distro([
        findingPlugin("warn", [
          { id: "many-locations", locations, message: "Finding with many locations." },
        ]),
      ]),
      { ...capture.runtime, cwd: "/workspace/project" },
    );

    expect(capture.stdout.text).toContain("location-99.md");
    expect(capture.stdout.text).not.toContain("location-100.md");
    expect(capture.stdout.text).toContain("+2 more locations");
    // --verbose is already spent here, so the only remaining route has to be on screen.
    expect(capture.stdout.text).toContain(
      "Show every finding without human output limits: acme check --json",
    );
  });

  it("bounds the length of one location line, not just how many print", async () => {
    const capture = createCapture(["check"]);
    const path = `/workspace/project/${"a".repeat(2000)}.md`;

    await runCli(
      distro([
        findingPlugin("warn", [{ id: "long-path", locations: [{ path }], message: "Long." }]),
      ]),
      { ...capture.runtime, cwd: "/workspace/project" },
    );

    expect(capture.stdout.text).toContain("…");
    expect(capture.stdout.text).not.toContain("a".repeat(600));
  });
});
