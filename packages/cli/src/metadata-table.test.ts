import type { FindingMetadataTablePresentation } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { runCli } from "./index.js";
import { renderFindingPresentation } from "./metadata-table.js";
import { parseCheckReport } from "./test-support/check-output-schema.js";
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
    const human = createCapture(["check", "--verbose"]);
    const json = createCapture(["check", "--json"]);

    expect(await runCli(distro([plugin]), human.runtime)).toBe(0);
    expect(human.stdout.text).toContain("File");
    expect(human.stdout.text).toContain("Bytes  Share  Loading");
    expect(human.stdout.text).toContain("32,001  80.0%");
    expect(human.stdout.text).toContain("conditional — not always loaded");
    expect(human.stdout.text).not.toContain(ESCAPE);

    expect(await runCli(distro([plugin]), json.runtime)).toBe(0);
    expect(parseCheckReport(json.stdout.text)).toMatchObject({
      findings: [{ metadata: { files: expect.any(Array) }, presentation }],
    });
  });

  it("stops printing rows a check did not bound and says how many are missing", async () => {
    const capture = createCapture(["check", "--verbose"]);
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
    expect(capture.stdout.text).toContain("… 150 more rows not shown");
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

  it("aligns CJK and emoji cells by terminal display width", () => {
    const lines = renderFindingPresentation({
      metadata: {
        rows: [
          { left: "界", right: "🙂" },
          { left: "ab", right: "x" },
        ],
      },
      presentation: {
        columns: [
          { heading: "Name", key: "left" },
          { align: "right", heading: "Value", key: "right" },
        ],
        kind: "metadata-table",
        rowsKey: "rows",
      },
    });

    expect(lines).toEqual(["Name  Value", "----  -----", "界       🙂", "ab        x"]);
  });

  it("caps columns at 80 cells without splitting grapheme clusters", () => {
    const combined = "e\u0301".repeat(100);
    const lines = renderFindingPresentation({
      metadata: { rows: [{ value: "a".repeat(300) }, { value: combined }] },
      presentation: {
        columns: [{ heading: "Value", key: "value" }],
        kind: "metadata-table",
        rowsKey: "rows",
      },
    });

    expect(lines[1]).toBe("-".repeat(80));
    expect(lines[2]).toBe(`${"a".repeat(79)}…`);
    expect(lines[3]).toBe(`${"e\u0301".repeat(79)}…`);
    expect(lines[3]).not.toContain("e…");
  });
});
