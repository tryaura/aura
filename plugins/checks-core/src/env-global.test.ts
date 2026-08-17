import { describe, expect, it } from "vitest";

import { env001 } from "./env-001.js";
import { env002 } from "./env-002.js";
import { app, model } from "./testing.js";

describe("ENV-001", () => {
  it("warns for unknown and unsupported versions with app guidance", () => {
    const unknown = app({ installHint: "Update Alpha.", status: "unknown" });
    const unsupported = app({
      adapterId: "beta",
      displayName: "Beta",
      installHint: "Update Beta.",
      status: "unsupported",
      version: "3.0.0",
    });

    const findings = env001.detect(model({ apps: [unknown, unsupported] }));

    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      details: "Update Alpha.",
      id: "unknown-version:alpha",
      metadata: { appId: "alpha", reportOnly: false, supportedRange: ">=1 <2" },
    });
    expect(findings[1]).toMatchObject({
      id: "unsupported-version:beta",
      metadata: { appId: "beta", reportOnly: true, supportedRange: ">=1 <2" },
    });
    expect(findings[1]?.details).toContain("report-only");
  });

  it("passes supported applications and does not invent missing ones", () => {
    expect(env001.detect(model({ apps: [app({ status: "supported" })] }))).toEqual([]);
    expect(env001.detect(model())).toEqual([]);
  });

  it("skips synthetic inventory adapters", () => {
    expect(env001.detect(model({ apps: [app({ status: "unknown", synthetic: true })] }))).toEqual(
      [],
    );
  });
});

describe("ENV-002", () => {
  it("reports only explicit unauthenticated results", () => {
    const findings = env002.detect(
      model({
        apps: [
          app({ authenticated: false }),
          app({ adapterId: "beta", authenticated: true }),
          app({ adapterId: "gamma" }),
        ],
      }),
    );

    expect(findings).toEqual([
      {
        details: "Open Alpha, sign in, then run `aura check` again.",
        id: "unauthenticated:alpha",
        message: "Alpha is installed but not authenticated.",
        metadata: { appId: "alpha" },
      },
    ]);
  });

  it("provides authentication commands for supported apps and a safe fallback", () => {
    const findings = env002.detect(
      model({
        apps: [
          app({ adapterId: "claude-code", authenticated: false, displayName: "Claude Code" }),
          app({ adapterId: "codex", authenticated: false, displayName: "Codex" }),
          app({ authenticated: false }),
        ],
      }),
    );

    expect(findings.map((finding) => finding.details)).toEqual([
      "Run `claude auth login`, complete authentication, then run `aura check` again.",
      "Run `codex login`, complete authentication, then run `aura check` again.",
      "Open Alpha, sign in, then run `aura check` again.",
    ]);
  });

  it("skips synthetic inventory adapters", () => {
    expect(
      env002.detect(model({ apps: [app({ authenticated: false, synthetic: true })] })),
    ).toEqual([]);
  });
});
