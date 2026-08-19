import { describe, expect, it } from "vitest";

import { runFixes } from "./fix.js";
import {
  automaticCheck,
  finding,
  guidedCheck,
  request,
  scriptedWizard,
  TextOutput,
  writePlan,
} from "./test-support/fix.js";

describe("runFixes report messages", () => {
  it("marks planned fixes with why nothing was applied when the wizard is aborted", async () => {
    const automatic = automaticCheck();
    const guided = guidedCheck({ fix: () => writePlan("guided.md", "guided") });

    const outcome = await runFixes(
      request({
        checks: [automatic, guided],
        findings: [finding(automatic, "auto"), finding(guided, "guided")],
        wizard: scriptedWizard(["aborted"]),
      }),
    );

    expect(outcome.exitCode).toBeUndefined();
    expect(outcome.fixes).toHaveLength(1);
    expect(outcome.fixes[0]?.status).toBe("planned");
    expect(outcome.fixes[0]?.message).toBe("Aborted before confirmation. Nothing was changed.");
  });

  it("marks planned fixes with why nothing was applied when no prompt is available", async () => {
    const automatic = automaticCheck();

    const outcome = await runFixes(
      request({ checks: [automatic], findings: [finding(automatic, "auto")] }),
    );

    expect(outcome.exitCode).toBe(2);
    expect(outcome.fixes).toHaveLength(1);
    expect(outcome.fixes[0]?.status).toBe("planned");
    expect(outcome.fixes[0]?.message).toBe(
      "Not applied: the confirmation prompt is unavailable in this terminal. Re-run with --yes, or --dry-run to stop at the preview.",
    );
  });

  it("attributes each previewed operation to the check that proposed it", async () => {
    const automatic = automaticCheck();
    const stdout = new TextOutput();

    await runFixes(
      request({
        checks: [automatic],
        dryRun: true,
        findings: [finding(automatic, "auto")],
        stdout,
      }),
    );

    const headerIndex = stdout.text.indexOf("[fixture/AUTO] Write automatic.md.");
    const operationIndex = stdout.text.search(/ {4}(?:create|update) /u);
    expect(headerIndex).toBeGreaterThan(-1);
    expect(operationIndex).toBeGreaterThan(headerIndex);
  });

  it("previews every candidate when same-path writes coalesce into one operation", async () => {
    const automatic = automaticCheck();
    const stdout = new TextOutput();

    await runFixes(
      request({
        checks: [automatic],
        dryRun: true,
        findings: [finding(automatic, "first"), finding(automatic, "second")],
        stdout,
      }),
    );

    const headers = stdout.text.split("[fixture/AUTO] Write automatic.md.").length - 1;
    expect(headers).toBe(2);
  });
});
