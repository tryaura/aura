import { describe, expect, it } from "vitest";

import { skillIdentity } from "../skill-planner-paths.js";
import { fakeCatalog, recordingIo, REMOTE_ENTRY, skillStepContext } from "./skills.test-support.js";
import { skillsStep } from "./skills.js";

describe("skillsStep search", () => {
  it("limits a large picker to ten initial rows and enables full-catalog search", async () => {
    const entries = Array.from({ length: 11 }, (_, index) => ({
      ...REMOTE_ENTRY,
      id: `skill-${String(index + 1)}`,
      identity: skillIdentity("directory:acme", `skill-${String(index + 1)}`),
      name: `Skill ${String(index + 1)}`,
    }));
    const scripted = recordingIo([]);

    await skillsStep.gather(skillStepContext(fakeCatalog({ entries })), scripted);

    const question = scripted.asked[0]?.[0];
    expect(question?.options).toHaveLength(11);
    expect(question?.search).toEqual({
      initialLimit: 10,
      placeholder: "Search all 11 skills",
    });
  });
});
