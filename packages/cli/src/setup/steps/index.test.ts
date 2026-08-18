import { describe, expect, it } from "vitest";

import { selectSetupSteps, setupAddKinds } from "./index.js";

describe("setup step registry", () => {
  it("registers MCP before Baseline and exposes setup --add mcp", () => {
    expect(selectSetupSteps(undefined)).toMatchObject({
      status: "ready",
      steps: [
        { id: "apps" },
        { id: "instructions" },
        { id: "snippets" },
        { id: "skills" },
        { id: "mcp" },
        { id: "baseline" },
      ],
    });
    expect(setupAddKinds()).toContain("mcp");
    expect(selectSetupSteps("mcp")).toMatchObject({ status: "ready", steps: [{ id: "mcp" }] });
  });
});
