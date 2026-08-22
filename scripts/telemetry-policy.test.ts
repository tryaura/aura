import { describe, expect, it } from "vitest";

import { OFFICIAL_TELEMETRY_IDS } from "../apps/web/src/telemetry-policy.js";
import { OFFICIAL_PLUGINS } from "../packages/cli/src/plugins.js";

describe("official telemetry policy values", () => {
  it("stays synchronized with every official plugin contribution", () => {
    expect(OFFICIAL_TELEMETRY_IDS).toEqual({
      applications: OFFICIAL_PLUGINS.flatMap(
        (plugin) => plugin.adapters?.map((adapter) => adapter.id) ?? [],
      ).toSorted(),
      bundledSkills: OFFICIAL_PLUGINS.flatMap(
        (plugin) => plugin.skills?.map((skill) => `plugin:${plugin.id}\0${skill.id}`) ?? [],
      ).toSorted(),
      checks: OFFICIAL_PLUGINS.flatMap(
        (plugin) => plugin.checks?.map((check) => check.id) ?? [],
      ).toSorted(),
      mcpCatalog: OFFICIAL_PLUGINS.flatMap(
        (plugin) => plugin.mcpCatalog?.map((server) => server.id) ?? [],
      ).toSorted(),
      snippets: OFFICIAL_PLUGINS.flatMap(
        (plugin) => plugin.snippets?.map((snippet) => snippet.id) ?? [],
      ).toSorted(),
    });
  });
});
