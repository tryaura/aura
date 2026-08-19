import { readFileSync } from "node:fs";

import { parseMcpServerManifest } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { validateTeamPreset } from "./preset/schema.js";

const INTERNAL_DISTRIBUTION = new URL(
  "../../../apps/web/src/content/docs/docs/guides/internal-distribution.md",
  import.meta.url,
);
const MCP_CATALOG = new URL(
  "../../../apps/web/src/content/docs/docs/reference/mcp-catalog.md",
  import.meta.url,
);
const TEAM_PRESET = new URL(
  "../../../apps/web/src/content/docs/docs/reference/team-preset.md",
  import.meta.url,
);

describe("documentation JSON examples", () => {
  it("keeps the internal distribution MCP catalog example valid", () => {
    expect(parseMcpServerManifest(onlyJsonFence(INTERNAL_DISTRIBUTION))).toHaveProperty("value");
  });

  it("keeps the MCP catalog reference example valid", () => {
    expect(parseMcpServerManifest(onlyJsonFence(MCP_CATALOG))).toHaveProperty("value");
  });

  it("keeps the team preset reference example valid", () => {
    const parsed: unknown = JSON.parse(onlyJsonFence(TEAM_PRESET));
    expect(validateTeamPreset(parsed)).toMatchObject({ kind: "preset" });
  });
});

function onlyJsonFence(document: URL): string {
  const fences = [
    ...readFileSync(document, "utf8").matchAll(/^```json[ \t]*\n([\s\S]*?)^```[ \t]*$/gmu),
  ].flatMap((match) => {
    const content = match[1];
    return content === undefined ? [] : [content];
  });
  expect(fences, `${document.pathname} must contain exactly one JSON fence`).toHaveLength(1);
  const example = fences[0];
  if (example === undefined) {
    throw new Error(`${document.pathname} has no JSON example`);
  }
  return example;
}
