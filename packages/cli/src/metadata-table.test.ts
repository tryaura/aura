import type { FindingMetadataTablePresentation } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { runCli } from "./index.js";
import { createCapture, distro, findingPlugin } from "./testing.js";

const ESCAPE = String.fromCharCode(27);

describe("finding metadata tables", () => {
  it("renders a generic metadata table and preserves its hint in JSON", async () => {
    const presentation: FindingMetadataTablePresentation = {
      columns: [
        { heading: "File", key: "path" },
        { align: "right", format: "integer", heading: "Bytes", key: "bytes" },
        {
          align: "right",
          format: "percentage",
          heading: "Share",
          key: "share",
        },
        {
          format: "boolean",
          heading: "Loading",
          key: "conditional",
          trueLabel: "conditional — not always loaded",
        },
      ],
      kind: "metadata-table",
      rowsKey: "files",
    };
    const plugin = findingPlugin("info", [
      {
        id: "budget",
        message: "Context budget exceeded.",
        metadata: {
          files: [
            { bytes: 32_001, path: `/workspace/${ESCAPE}rules.md`, share: 0.8 },
            {
              bytes: 8_000,
              conditional: true,
              path: "/workspace/conditional.mdc",
              share: 0.2,
            },
          ],
        },
        presentation,
      },
    ]);
    const human = createCapture(["check"]);
    const json = createCapture(["check", "--json"]);

    expect(await runCli(distro([plugin]), human.runtime)).toBe(0);
    expect(human.stdout.text).toContain("File");
    expect(human.stdout.text).toContain("Bytes  Share  Loading");
    expect(human.stdout.text).toContain("32,001  80.0%");
    expect(human.stdout.text).toContain("conditional — not always loaded");
    expect(human.stdout.text).not.toContain(ESCAPE);

    expect(await runCli(distro([plugin]), json.runtime)).toBe(0);
    expect(JSON.parse(json.stdout.text)).toMatchObject({
      findings: [{ metadata: { files: expect.any(Array) }, presentation }],
    });
  });

  it("stops printing rows a check did not bound and says how many are missing", async () => {
    const capture = createCapture(["check"]);
    const plugin = findingPlugin("info", [
      {
        id: "unbounded",
        message: "Context budget exceeded.",
        metadata: {
          files: Array.from({ length: 250 }, (_, index) => ({
            path: `/workspace/rule-${String(index)}.md`,
          })),
        },
        presentation: {
          columns: [{ heading: "File", key: "path" }],
          kind: "metadata-table",
          rowsKey: "files",
        },
      },
    ]);

    expect(await runCli(distro([plugin]), capture.runtime)).toBe(0);
    expect(capture.stdout.text).toContain("/workspace/rule-99.md");
    expect(capture.stdout.text).not.toContain("/workspace/rule-100.md");
    expect(capture.stdout.text).toContain("… 150 more row(s) not shown");
  });

  it("ignores a metadata-table hint whose rows are not an array", async () => {
    const capture = createCapture(["check"]);
    const plugin = findingPlugin("info", [
      {
        id: "invalid-table",
        message: "Finding remains visible.",
        metadata: { files: "not rows" },
        presentation: {
          columns: [{ heading: "File", key: "path" }],
          kind: "metadata-table",
          rowsKey: "files",
        },
      },
    ]);

    expect(await runCli(distro([plugin]), capture.runtime)).toBe(0);
    expect(capture.stdout.text).toContain("Finding remains visible.");
    expect(capture.stdout.text).not.toContain("File\n");
  });
});
