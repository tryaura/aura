import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { FileProblem, FixPlan, WorkspaceModel } from "@tryaura/aura-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { FILE_PROBLEM_MESSAGES } from "../file-problem-messages.js";
import { previewFixPlan } from "../index.js";
import { MAX_MUTABLE_FILE_BYTES } from "./limits.js";
import { createFixPlanFixture, type FixPlanFixture } from "./testing.js";

const PROBLEMS: readonly FileProblem[] = [
  "denied",
  "loop",
  "outside-project",
  "resources",
  "too-large",
  "too-many-entries",
  "unreadable",
  "unsupported",
];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("fix-plan scan problem refusal", () => {
  it.each(PROBLEMS)("refuses a write whose declared source has problem %s", async (problem) => {
    const fixture = await createFixture();
    const path = join(fixture.workspace, ".claude.json");
    await writeFile(path, "user configuration\n", "utf8");
    const model = withProblem(fixture.model, path, problem);

    const preview = await previewFixPlan({
      model,
      plan: writePlan(path, "regenerated\n"),
    });

    // The whole sentence, not a fragment: a conflict reaches the user verbatim, so a message that
    // stopped naming the file or dropped the closing instruction should fail here.
    expect(preview.operations[0]).toMatchObject({
      conflict: `Aura could not read ${path} during the scan: ${FILE_PROBLEM_MESSAGES[problem]}. Changing it now could discard content Aura never read; fix the file, then re-run`,
      effect: "conflict",
    });
    await expect(readFile(path, "utf8")).resolves.toBe("user configuration\n");
  });

  it("refuses a coalesced write group before reading the target", async () => {
    const fixture = await createFixture();
    const path = join(fixture.workspace, ".claude.json");
    await writeFile(path, "base\n", "utf8");

    const preview = await previewFixPlan({
      model: withProblem(fixture.model, path, "denied"),
      plan: {
        operations: [
          { content: "first\n", path, type: "write" },
          { content: "second\n", path, type: "write" },
        ],
        summary: "Coalesce two writes.",
      },
    });

    expect(preview.operations).toHaveLength(1);
    expect(preview.operations[0]).toMatchObject({ effect: "conflict" });
    await expect(readFile(path, "utf8")).resolves.toBe("base\n");
  });

  it("reports the scan problem ahead of a size rejection, as an uncoalesced write does", async () => {
    const fixture = await createFixture();
    const path = join(fixture.workspace, ".claude.json");
    await writeFile(path, "base\n", "utf8");

    const preview = await previewFixPlan({
      model: withProblem(fixture.model, path, "denied"),
      plan: {
        operations: [
          { content: "first\n", path, type: "write" },
          { content: "a".repeat(MAX_MUTABLE_FILE_BYTES + 1), path, type: "write" },
        ],
        summary: "Coalesce a write that is also too large.",
      },
    });

    // Whether a write happened to be coalesced must not change which conflict the user is shown.
    expect(preview.operations[0]?.conflict).toBe(
      `Aura could not read ${path} during the scan: ${FILE_PROBLEM_MESSAGES.denied}. Changing it now could discard content Aura never read; fix the file, then re-run`,
    );
  });

  it("checks both mutation paths of a move", async () => {
    const fixture = await createFixture();
    const sourcePath = join(fixture.workspace, "source.md");
    const destinationPath = join(fixture.workspace, "destination.md");
    await writeFile(sourcePath, "source\n", "utf8");

    const preview = await previewFixPlan({
      model: withProblem(fixture.model, destinationPath, "unreadable"),
      plan: {
        operations: [{ destinationPath, sourcePath, type: "move" }],
        summary: "Move a file.",
      },
    });

    expect(preview.operations[0]).toMatchObject({ effect: "conflict" });
    await expect(readFile(sourcePath, "utf8")).resolves.toBe("source\n");
  });
});

function withProblem(model: WorkspaceModel, path: string, problem: FileProblem): WorkspaceModel {
  return {
    ...model,
    apps: model.apps.map((app) => ({
      ...app,
      sourceFiles: [
        ...app.sourceFiles,
        {
          exists: true,
          problem,
          spec: { id: "problematic", kind: "config", path, scope: "project" },
        },
      ],
    })),
  };
}

function writePlan(path: string, content: string): FixPlan {
  return {
    operations: [{ content, path, type: "write" }],
    summary: "Rewrite a problematic source.",
  };
}

async function createFixture(): Promise<FixPlanFixture> {
  const fixture = await createFixPlanFixture();
  temporaryDirectories.push(fixture.root);
  return fixture;
}
