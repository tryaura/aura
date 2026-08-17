import { describe, expect, it } from "vitest";

import type { CheckExplanation, CheckReport } from "./report.js";
import {
  assertValidCheckOutput,
  parseCheckExplanation,
  parseCheckReport,
} from "./test-support/check-output-schema.js";

describe("check-output-v1.schema.json", () => {
  it("validates a report containing every optional nested shape", () => {
    const report: CheckReport = {
      apps: [
        {
          appId: "fixture",
          detection: { authenticated: true, installed: true, version: "1.2.3" },
          displayName: "Fixture App",
          support: { status: "supported", supportedRange: ">=1 <2", version: "1.2.3" },
        },
      ],
      diagnostics: [
        {
          detail: "Parser detail",
          id: "fixture",
          message: "Fixture failed while parsing.",
          path: "/workspace/config.json",
          phase: "parse",
        },
      ],
      findings: [
        {
          checkId: "fixture/CHECK",
          details: "Finding detail",
          findingId: "finding",
          fixability: "guided",
          locations: [{ column: 3, line: 2, path: "/workspace/AGENTS.md" }],
          message: "Finding message",
          metadata: { files: [{ bytes: 42, path: "/workspace/AGENTS.md" }] },
          presentation: {
            columns: [
              { heading: "File", key: "path" },
              { align: "right", format: "integer", heading: "Bytes", key: "bytes" },
            ],
            kind: "metadata-table",
            rowsKey: "files",
          },
          scope: "project",
          severity: "warn",
        },
      ],
      fixes: [
        {
          checkId: "fixture/CHECK",
          findingId: "finding",
          manualSteps: ["Review the generated file."],
          message: "The plan is conflicted.",
          operations: [
            {
              conflict: "The target changed.",
              diff: "diff --aura",
              effect: "conflict",
              paths: ["/workspace/AGENTS.md"],
            },
          ],
          status: "failed",
          summary: "Repair the fixture.",
        },
      ],
      kind: "check-report",
      passedChecks: [{ id: "fixture/PASS", title: "Passing fixture" }],
      schemaVersion: 1,
      status: "operational-error",
      summary: {
        categories: {
          CHECK: { errors: 0, informational: 0, passed: 1, warnings: 1 },
        },
        diagnostics: 1,
        errors: 0,
        exitCode: 3,
        informational: 0,
        passed: 1,
        warnings: 1,
      },
    };

    expect(parseCheckReport(JSON.stringify(report))).toEqual(report);
  });

  it("validates a planned fix carrying the reason nothing was applied", () => {
    const report = createCheckReport({
      adapters: [],
      apps: [],
      checkDiagnostics: [],
      checks: [],
      findings: [],
      fixes: [
        {
          checkId: "fixture/CHECK",
          findingId: "fixture-finding",
          manualSteps: [],
          message: "Aborted before confirmation. Nothing was changed.",
          operations: [{ effect: "update", paths: ["/home/dev/agents/AGENTS.md"] }],
          status: "planned",
          summary: "Rewrite the shared instructions.",
        },
      ],
      scanDiagnostics: [],
      skipped: [],
      withDetail: false,
    });

    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
  });

  it("validates the explanation envelope", () => {
    const explanation: CheckExplanation = {
      explain: "Why this matters.\n\nHow to inspect it.",
      fixability: "manual",
      fixesApplicable: false,
      id: "fixture/CHECK",
      kind: "check-explanation",
      schemaVersion: 1,
      scope: "global",
      severity: "warn",
      title: "Fixture check",
    };

    expect(parseCheckExplanation(JSON.stringify(explanation))).toEqual(explanation);
  });

  it("rejects schema drift", () => {
    expect(() =>
      assertValidCheckOutput({
        kind: "check-report",
        schemaVersion: 1,
        unexpected: true,
      }),
    ).toThrow("does not match v1 schema");
  });
});
