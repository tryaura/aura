import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { renderCheckHelp, renderRootHelp, renderSetupHelp, renderUndoHelp } from "./help.js";
import { setupAddKinds } from "./setup/steps/index.js";
import { parseCheckReport } from "./test-support/check-output-schema.js";

const BRANDING = { command: "aura", displayName: "Aura", version: "0.5.1" };
const CLI_REFERENCE = new URL(
  "../../../apps/web/src/content/docs/docs/reference/cli.mdx",
  import.meta.url,
);
const CHECK_JSON = new URL(
  "../../../apps/web/src/content/docs/docs/reference/check-json.mdx",
  import.meta.url,
);

function helpScreens(): string {
  return [
    renderRootHelp(BRANDING),
    renderSetupHelp(BRANDING, setupAddKinds()),
    renderCheckHelp(BRANDING),
    renderUndoHelp(BRANDING),
  ].join("\n");
}

function options(text: string): ReadonlySet<string> {
  return new Set(text.match(/--[a-z][a-z-]*/gu) ?? []);
}

describe("public CLI documentation", () => {
  it("covers every visible help option", () => {
    const documented = readFileSync(CLI_REFERENCE, "utf8");

    for (const option of options(helpScreens())) {
      expect(documented, `CLI reference is missing ${option}`).toContain(option);
    }
  });

  it("documents no option the CLI cannot accept", () => {
    const help = helpScreens();
    // Only the option tables are authoritative: prose names shell flags Aura does not own, and a
    // retired flag survives longest in a table row that still looks canonical.
    const rows = readFileSync(CLI_REFERENCE, "utf8").matchAll(/^\|\s*`([^`]+)`/gmu);

    for (const row of rows) {
      for (const option of options(row[1] ?? "")) {
        expect(help, `CLI reference documents unknown ${option}`).toContain(option);
      }
    }
  });

  it("keeps the documented check report valid", () => {
    const document = readFileSync(CHECK_JSON, "utf8");
    const match = /^[ \t]*```json(?:[ \t]+[^\n]*)?\n([\s\S]*?)^[ \t]*```[ \t]*$/gmu.exec(document);
    expect(match?.[1]).toBeDefined();
    expect(parseCheckReport(match?.[1] ?? "")).toBeDefined();
  });
});
