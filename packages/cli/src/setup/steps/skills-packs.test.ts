import { describe, expect, it } from "vitest";

import { skillIdentity } from "../skill-planner-paths.js";
import { fakeCatalog, recordingIo, REMOTE_ENTRY, skillStepContext } from "./skills.test-support.js";
import { skillsStep } from "./skills.js";

const SECOND_ENTRY = {
  ...REMOTE_ENTRY,
  id: "triage",
  identity: skillIdentity("directory:acme", "triage"),
  name: "Triage",
};

describe("skillsStep packs", () => {
  it("offers a plugin pack as a group row whose members are the offered catalog rows", async () => {
    const scripted = recordingIo([]);
    const catalog = fakeCatalog({
      entries: [REMOTE_ENTRY, SECOND_ENTRY],
      listingPacks: [
        {
          description: "The everyday starter set.",
          id: "official/starter",
          name: "Starter",
          skills: [
            { id: "review", source: "directory:acme" },
            { id: "triage", source: "directory:acme" },
            { id: "not-listed", source: "directory:acme" },
          ],
        },
      ],
    });

    await skillsStep.gather(skillStepContext(catalog), scripted);

    const row = scripted.asked[0]?.[0]?.options.find((option) => option.value.startsWith("pack:"));
    expect(row?.label).toBe("Starter — 2 skills");
    expect(row?.group).toBe("Skill packs");
    expect(row?.disabled).toBeUndefined();
    expect(row?.members).toEqual([REMOTE_ENTRY.identity, SECOND_ENTRY.identity]);
  });

  it("disables a pack none of whose members are offered this run", async () => {
    const scripted = recordingIo([]);
    const catalog = fakeCatalog({
      entries: [REMOTE_ENTRY],
      listingPacks: [
        {
          description: "Nothing here applies.",
          id: "official/elsewhere",
          name: "Elsewhere",
          skills: [{ id: "not-listed", source: "directory:acme" }],
        },
      ],
    });

    await skillsStep.gather(skillStepContext(catalog), scripted);

    const row = scripted.asked[0]?.[0]?.options.find((option) => option.value.startsWith("pack:"));
    expect(row?.disabled).toBe(true);
    expect(row?.disabledNote).toBe("no member is available in this run");
    expect(row?.members).toEqual([]);
  });
});
