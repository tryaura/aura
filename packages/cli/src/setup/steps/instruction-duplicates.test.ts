import { describe, expect, it } from "vitest";

import type { DuplicateCluster, InstructionSource } from "../instructions.js";
import { SETUP_ABORTED } from "../types.js";
import { createScriptedWizardIo, type ScriptedWizardScript } from "../wizard-scripted.js";
import type { WizardIo, WizardQuestion } from "../wizard-types.js";
import { gatherDuplicateWinners } from "./instruction-duplicates.js";

describe("gatherDuplicateWinners", () => {
  it("settles an identical cluster on the first member without asking", async () => {
    const harness = createHarness();

    const winners = await gatherDuplicateWinners(
      "global",
      ["/home/dev/a.md", "/home/dev/b.md"],
      sources(),
      [cluster("same", true)],
      harness.io,
    );

    expect(harness.asked).toEqual([]);
    expect(winners).toEqual({ same: "/home/dev/a.md:1:1" });
  });

  it("asks only about divergent clusters and merges both kinds of winner", async () => {
    const harness = createHarness({
      forms: [{ "global-duplicate-0": { kind: "options", values: ["/home/dev/b.md:3:3"] } }],
    });

    const winners = await gatherDuplicateWinners(
      "global",
      ["/home/dev/a.md", "/home/dev/b.md"],
      sources(),
      [cluster("same", true), cluster("drifted", false, 3)],
      harness.io,
    );

    expect(harness.asked).toHaveLength(1);
    expect(harness.asked[0]?.map((question) => question.id)).toEqual(["global-duplicate-0"]);
    expect(winners).toEqual({
      drifted: "/home/dev/b.md:3:3",
      same: "/home/dev/a.md:1:1",
    });
  });

  it("skips an identical cluster whose other copies were deselected", async () => {
    const harness = createHarness();

    const winners = await gatherDuplicateWinners(
      "global",
      ["/home/dev/a.md"],
      sources(),
      [cluster("same", true)],
      harness.io,
    );

    expect(harness.asked).toEqual([]);
    expect(winners).toEqual({});
  });

  it("still aborts from a divergent-cluster question", async () => {
    const harness = createHarness({ forms: ["aborted"] });

    const winners = await gatherDuplicateWinners(
      "global",
      ["/home/dev/a.md", "/home/dev/b.md"],
      sources(),
      [cluster("same", true), cluster("drifted", false, 3)],
      harness.io,
    );

    expect(winners).toBe(SETUP_ABORTED);
  });
});

interface Harness {
  readonly asked: readonly (readonly WizardQuestion[])[];
  readonly io: WizardIo;
}

/** A scripted wizard that also records every form it was shown. */
function createHarness(script: ScriptedWizardScript = {}): Harness {
  const scripted = createScriptedWizardIo(script);
  const asked: (readonly WizardQuestion[])[] = [];

  return {
    asked,
    io: {
      ask: async (questions) => {
        asked.push(questions);
        return scripted.ask(questions);
      },
      confirm: scripted.confirm,
      load: scripted.load,
      note: scripted.note,
    },
  };
}

function sources(): readonly InstructionSource[] {
  const content = "Shared guidance line.\n\nMore guidance.\n\nA third paragraph.\n";
  return [
    { content, path: "/home/dev/a.md", scope: "global" },
    { content, path: "/home/dev/b.md", scope: "global" },
  ];
}

function cluster(id: string, identical: boolean, line = 1): DuplicateCluster {
  return {
    id,
    identical,
    members: [
      {
        endLine: line,
        id: `/home/dev/a.md:${String(line)}:${String(line)}`,
        path: "/home/dev/a.md",
        startLine: line,
      },
      {
        endLine: line,
        id: `/home/dev/b.md:${String(line)}:${String(line)}`,
        path: "/home/dev/b.md",
        startLine: line,
      },
    ],
    similarity: identical ? 100 : 85,
  };
}
