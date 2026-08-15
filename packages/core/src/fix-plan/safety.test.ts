import { execFile } from "node:child_process";
import { lstat, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { promisify } from "node:util";

import type { FixPlan } from "@tryaura/aura-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { executeFixPlan, FixPlanError, previewFixPlan } from "../index.js";
import { createFixPlanFixture, type FixPlanFixture } from "./testing.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("fix-plan path safety", () => {
  it("rejects relative paths, traversals, sibling prefixes, and managed roots", async () => {
    const fixture = await createFixture();
    const invalidPaths = [
      "relative.md",
      `${fixture.workspace}${sep}nested${sep}..${sep}escaped.md`,
      `${fixture.workspace}-other${sep}escaped.md`,
      fixture.workspace,
      join(fixture.home, "agents"),
    ];

    for (const path of invalidPaths) {
      const plan = writePlan(path);
      await expect(previewFixPlan({ model: fixture.model, plan })).rejects.toMatchObject({
        code: "invalid-path",
        operationIndex: 0,
        path,
      });
    }
  });

  it("rejects intermediate symlinks and symlink targets that resolve outside allowed roots", async () => {
    const fixture = await createFixture();
    const outside = join(fixture.root, "outside");
    const linkedDirectory = join(fixture.workspace, "linked");
    const managed = join(fixture.home, "agents");
    await mkdir(outside);
    await mkdir(managed);
    await symlink(outside, linkedDirectory);

    await expect(
      previewFixPlan({
        model: fixture.model,
        plan: writePlan(join(linkedDirectory, "config.md")),
      }),
    ).rejects.toMatchObject({ code: "invalid-path", path: linkedDirectory });

    const outsideTargetPlan: FixPlan = {
      operations: [
        {
          path: join(fixture.workspace, "AGENTS.md"),
          target: join(outside, "AGENTS.md"),
          type: "symlink",
        },
      ],
      summary: "Link outside.",
    };
    await expect(
      previewFixPlan({ model: fixture.model, plan: outsideTargetPlan }),
    ).rejects.toMatchObject({ code: "invalid-path", path: join(outside, "AGENTS.md") });

    const escapedTarget = join(managed, "escaped.md");
    await writeFile(join(outside, "target.md"), "outside\n", "utf8");
    await symlink(join(outside, "target.md"), escapedTarget);
    const finalSymlinkPlan: FixPlan = {
      operations: [
        {
          path: join(fixture.workspace, "linked-agents.md"),
          target: escapedTarget,
          type: "symlink",
        },
      ],
      summary: "Link through a link.",
    };
    await expect(
      previewFixPlan({ model: fixture.model, plan: finalSymlinkPlan }),
    ).rejects.toMatchObject({ code: "invalid-path", path: escapedTarget });
  });

  it("rejects a managed home root that is itself a symbolic link", async () => {
    const fixture = await createFixture();
    const outside = join(fixture.root, "outside-managed");
    const managed = join(fixture.home, "agents");
    await mkdir(outside);
    await symlink(outside, managed);

    await expect(
      previewFixPlan({ model: fixture.model, plan: writePlan(join(managed, "AGENTS.md")) }),
    ).rejects.toMatchObject({ code: "invalid-path", path: managed });
  });

  it("rejects overlapping operation paths", async () => {
    const fixture = await createFixture();
    const directory = join(fixture.workspace, "generated");
    const plan: FixPlan = {
      operations: [
        { content: "generated\n", path: join(directory, "config.md"), type: "write" },
        { path: directory, type: "remove" },
      ],
      summary: "Conflicting paths.",
    };

    await expect(previewFixPlan({ model: fixture.model, plan })).rejects.toMatchObject({
      code: "path-conflict",
      operationIndex: 1,
      path: directory,
    });
  });

  it("preflights the complete plan before applying an earlier valid operation", async () => {
    const fixture = await createFixture();
    const validPath = join(fixture.workspace, "would-have-been-written.md");
    const plan: FixPlan = {
      operations: [
        { content: "content\n", path: validPath, type: "write" },
        { content: "escaped\n", path: join(fixture.root, "outside.md"), type: "write" },
      ],
      summary: "Reject before writes.",
    };

    await expect(executeFixPlan({ model: fixture.model, plan })).rejects.toBeInstanceOf(
      FixPlanError,
    );
    await expect(lstat(validPath)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("rejects conflicting filesystem states with operation-indexed errors", async () => {
    const fixture = await createFixture();
    const nonempty = join(fixture.workspace, "nonempty");
    const source = join(fixture.workspace, "source.md");
    const destination = join(fixture.workspace, "destination.md");
    await mkdir(nonempty);
    await writeFile(join(nonempty, "child.md"), "child\n", "utf8");
    await writeFile(source, "source\n", "utf8");
    await writeFile(destination, "destination\n", "utf8");

    await expect(
      previewFixPlan({ model: fixture.model, plan: removePlan(nonempty) }),
    ).rejects.toMatchObject({ code: "path-conflict", operationIndex: 0, path: nonempty });

    const movePlan: FixPlan = {
      operations: [{ destinationPath: destination, sourcePath: source, type: "move" }],
      summary: "Move into a conflict.",
    };
    await expect(previewFixPlan({ model: fixture.model, plan: movePlan })).rejects.toMatchObject({
      code: "path-conflict",
      operationIndex: 0,
      path: destination,
    });
  });

  it.skipIf(process.platform === "win32")("rejects unsupported filesystem nodes", async () => {
    const fixture = await createFixture();
    const pipe = join(fixture.workspace, "config.pipe");
    await promisify(execFile)("mkfifo", [pipe]);

    await expect(
      previewFixPlan({ model: fixture.model, plan: removePlan(pipe) }),
    ).rejects.toMatchObject({
      code: "unsupported-path",
      operationIndex: 0,
      path: pipe,
    });
  });
});

function writePlan(path: string): FixPlan {
  return {
    operations: [{ content: "content\n", path, type: "write" }],
    summary: "Write a fixture.",
  };
}

function removePlan(path: string): FixPlan {
  return { operations: [{ path, type: "remove" }], summary: "Remove a fixture." };
}

async function createFixture(): Promise<FixPlanFixture> {
  const fixture = await createFixPlanFixture();
  temporaryDirectories.push(fixture.root);
  return fixture;
}
