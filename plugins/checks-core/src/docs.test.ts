import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import checksPlugin from "./index.js";

const CHECK_CATALOG = new URL(
  "../../../apps/web/src/content/docs/docs/reference/checks.mdx",
  import.meta.url,
);

function catalog(): string {
  return readFileSync(CHECK_CATALOG, "utf8");
}

function registeredIds(): ReadonlySet<string> {
  return new Set((checksPlugin.checks ?? []).map((check) => check.id));
}

describe("public check catalog", () => {
  it("lists every registered check with its default severity and fixability", () => {
    const document = catalog();

    for (const check of checksPlugin.checks ?? []) {
      const row = new RegExp(
        `\\|\\s*\`${check.id}\`\\s*\\|\\s*${check.defaultSeverity}\\s*\\|\\s*${check.fixability}\\s*\\|`,
        "u",
      );
      expect(document, `check catalog is stale for ${check.id}`).toMatch(row);
    }
  });

  it("lists no check this release stopped registering", () => {
    const registered = registeredIds();
    // A retired check leaves a row that still reads as canonical, so the table has to be exhaustive
    // in both directions; prose may still name an unregistered ID, such as a deliberate omission.
    const rows = catalog().matchAll(/^\|\s*`([A-Z]{3}-\d{3})`\s*\|/gmu);

    for (const row of rows) {
      expect(registered, `check catalog still lists ${row[1] ?? ""}`).toContain(row[1]);
    }
  });
});
