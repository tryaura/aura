import { runChecks } from "@tryaura/core";
import { describe, expect, it } from "vitest";

import { unmanagedDetectedAppCheck } from "./mgd-003.js";
import { app, model } from "./testing.js";

describe("MGD-003", () => {
  it("reports a detected app absent from a missing manifest", () => {
    const workspace = model({ apps: [app({ adapterId: "cursor", displayName: "Cursor" })] });
    const finding = runChecks([unmanagedDetectedAppCheck], workspace).findings[0];
    if (finding === undefined) {
      throw new Error("expected MGD-003 finding");
    }

    expect(finding).toMatchObject({ id: "cursor", severity: "info" });
    expect(finding.message).toContain("Cursor detected but not managed");
    // Manual on purpose: the decision is the apps step, so there is no fix to offer here.
    expect(unmanagedDetectedAppCheck.fixability).toBe("manual");
    expect(finding.details).toContain("aura setup");
  });

  it("silences ignored, managed:false, managed, and synthetic applications", () => {
    const apps = [
      app({ adapterId: "ignored" }),
      app({ adapterId: "disabled" }),
      app({ adapterId: "managed" }),
      app({ adapterId: "legacy", synthetic: true }),
    ];
    const workspace = model({
      apps,
      manifest: {
        exists: true,
        path: "/home/dev/agents/aura.json",
        status: "ready",
        value: {
          apps: { disabled: { managed: false }, managed: { managed: true } },
          ignoredApps: ["ignored"],
          mcpServers: [],
          ownership: {},
          schemaVersion: 1,
          skills: [],
          snippets: [],
        },
      },
    });

    expect(runChecks([unmanagedDetectedAppCheck], workspace).findings).toEqual([]);
  });
});
