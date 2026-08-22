import { readFileSync } from "node:fs";

import { parseMcpServerManifest } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { validateTeamPreset } from "./preset/schema.js";

const MCP_CATALOG = new URL(
  "../../../apps/web/src/content/docs/docs/reference/mcp-catalog.mdx",
  import.meta.url,
);
const TEAM_PRESET = new URL(
  "../../../apps/web/src/content/docs/docs/reference/team-preset.mdx",
  import.meta.url,
);

describe("documentation JSON examples", () => {
  it("keeps every MCP catalog reference example valid", () => {
    for (const example of jsonFences(MCP_CATALOG)) {
      expect(parseMcpServerManifest(example)).toHaveProperty("value");
    }
  });

  it("keeps the team preset reference example valid", () => {
    const [example] = jsonFences(TEAM_PRESET);
    expect(example).toBeDefined();
    const parsed: unknown = JSON.parse(example ?? "");
    expect(validateTeamPreset(parsed)).toMatchObject({ kind: "preset" });
  });
});

function jsonFences(document: URL): readonly string[] {
  const fences = [
    ...readFileSync(document, "utf8").matchAll(
      /^[ \t]*```json(?:[ \t]+[^\n]*)?\n([\s\S]*?)^[ \t]*```[ \t]*$/gmu,
    ),
  ].flatMap((match) => {
    const content = match[1];
    return content === undefined ? [] : [content];
  });
  expect(fences.length, `${document.pathname} must contain a JSON fence`).toBeGreaterThan(0);
  return fences;
}
