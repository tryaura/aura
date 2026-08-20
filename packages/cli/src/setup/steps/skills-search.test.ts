import { describe, expect, it } from "vitest";

import { skillIdentity } from "../skill-planner-paths.js";
import { createScriptedWizardIo } from "../wizard-scripted.js";
import type { WizardQuestion } from "../wizard-types.js";
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

  it("offers a 1117-entry catalog whole, with search over every row", async () => {
    const entries = Array.from({ length: 1_117 }, (_, index) => ({
      ...REMOTE_ENTRY,
      id: `skill-${String(index + 1)}`,
      identity: skillIdentity("directory:acme", `skill-${String(index + 1)}`),
      name: `Skill ${String(index + 1)}`,
    }));
    const scripted = recordingIo([]);

    await skillsStep.gather(skillStepContext(fakeCatalog({ entries })), scripted);

    const question = scripted.asked[0]?.[0];
    expect(question?.options).toHaveLength(1_117);
    expect(question?.search).toEqual({
      initialLimit: 10,
      placeholder: "Search all 1117 skills",
    });
  });

  it("gives a remote row a lazy preview that resolves through the shared pack cache", async () => {
    const scripted = recordingIo([]);
    const packs = new Map([
      [
        REMOTE_ENTRY.identity,
        {
          description: "Review changes before landing.",
          files: [{ content: "# Review skill\n", path: "SKILL.md" }],
          id: "review",
          name: "Review",
          source: {
            id: "directory:acme",
            kind: "directory",
            name: "Acme Skills",
            url: "https://skills.acme.example",
          },
          treeHash: "3".repeat(64),
          version: "1.0.0",
        } as const,
      ],
    ]);

    await skillsStep.gather(
      skillStepContext(fakeCatalog({ entries: [REMOTE_ENTRY], packs })),
      scripted,
    );

    const row = scripted.asked[0]?.[0]?.options.find(
      (option) => option.value === REMOTE_ENTRY.identity,
    );
    expect(row?.preview).toBeUndefined();
    await expect(row?.loadPreview?.()).resolves.toBe("# Review skill\n");
  });

  it("renders a truncated source as one leading disabled row naming both numbers", async () => {
    const scripted = recordingIo([]);
    const catalog = fakeCatalog({
      entries: [REMOTE_ENTRY],
      truncatedSources: [
        { advertised: 12_000, id: "directory:acme", name: "Acme Skills", read: 10_000 },
      ],
    });

    await skillsStep.gather(skillStepContext(catalog), scripted);

    const first = scripted.asked[0]?.[0]?.options[0];
    expect(first?.label).toBe("Acme Skills (truncated)");
    expect(first?.disabled).toBe(true);
    expect(first?.description).toBe(
      "showing 10000 of 12000 entries — the rest cannot be listed until the catalog narrows upstream",
    );
    expect(scripted.asked[0]?.[0]?.options[1]?.label).toBe("Review");
  });

  it("opens before repository verification settles and disables a stale row in place", async () => {
    const verification = Promise.withResolvers<void>();
    const opened = Promise.withResolvers<WizardQuestion>();
    const repainted = Promise.withResolvers<void>();
    const submit = Promise.withResolvers<void>();
    const listeners = new Set<() => void>();
    let missing = false;
    const catalog = fakeCatalog({
      entries: [REMOTE_ENTRY],
      verification: {
        isMissing: () => missing,
        settled: verification.promise,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
    });
    const base = createScriptedWizardIo();
    const gathering = skillsStep.gather(skillStepContext(catalog), {
      ...base,
      ask: async (questions) => {
        const question = questions[0];
        if (question === undefined) {
          throw new Error("expected skills picker");
        }
        const stop = question.subscribe?.(() => repainted.resolve());
        if (stop === undefined) {
          throw new Error("expected live picker subscription");
        }
        opened.resolve(question);
        await submit.promise;
        stop();
        return base.ask(questions);
      },
    });

    const question = await opened.promise;
    expect(question.options[0]?.disabled).toBe(false);
    let settled = false;
    const settlement = verification.promise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    missing = true;
    for (const listener of listeners) {
      listener();
    }
    verification.resolve();
    await repainted.promise;

    expect(question.options[0]?.disabled).toBe(true);
    expect(question.options[0]?.disabledNote).toBe("source no longer publishes this skill");
    submit.resolve();
    await expect(gathering).resolves.toEqual({});
    await settlement;
  });
});
