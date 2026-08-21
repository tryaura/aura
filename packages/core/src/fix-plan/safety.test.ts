/* eslint-disable max-lines -- one kernel safety matrix exercises cross-operation invariants. */
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { promisify } from "node:util";

import type { FixPlan } from "@tryaura/aura-sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyFixPlan,
  executeFixPlan,
  FixPlanError,
  prepareFixPlan,
  previewFixPlan,
} from "../index.js";
import { MAX_MUTABLE_FILE_BYTES } from "./limits.js";
import { createFixPlanFixture, type FixPlanFixture } from "./testing.js";

const temporaryDirectories: string[] = [];
const restoreModes: string[] = [];
const now = (): Date => new Date("2026-08-15T00:00:00.000Z");

afterEach(async () => {
  // A directory stripped of write permission has to get it back before it can be removed.
  await Promise.all(restoreModes.splice(0).map((path) => chmod(path, 0o700)));
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

  it("rejects every mutation kind inside a repository", async () => {
    const fixture = await createFixture();
    const project = join(fixture.root, "project");
    await mkdir(project);
    const model = { ...fixture.model, cwd: project, projectRoot: project };
    const target = join(project, "target.md");
    const plans: readonly FixPlan[] = [
      { operations: [{ content: "content\n", path: target, type: "write" }], summary: "write" },
      { operations: [{ path: target, type: "remove" }], summary: "remove" },
      {
        operations: [
          { destinationPath: join(project, "moved.md"), sourcePath: target, type: "move" },
        ],
        summary: "move",
      },
      {
        operations: [{ path: target, relativePath: "project/target.md", type: "archive" }],
        summary: "archive",
      },
      {
        operations: [
          { path: target, target: join(fixture.home, "agents", "AGENTS.md"), type: "symlink" },
        ],
        summary: "symlink",
      },
    ];

    for (const plan of plans) {
      await expect(previewFixPlan({ model, plan })).rejects.toMatchObject({
        code: "invalid-path",
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

    await expect(executeFixPlan({ model: fixture.model, now, plan })).rejects.toBeInstanceOf(
      FixPlanError,
    );
    await expect(lstat(validPath)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("reports conflicting filesystem states as previews instead of rejecting the plan", async () => {
    const fixture = await createFixture();
    const nonempty = join(fixture.workspace, "nonempty");
    const source = join(fixture.workspace, "source.md");
    const destination = join(fixture.workspace, "destination.md");
    const fine = join(fixture.workspace, "fine.md");
    await mkdir(nonempty);
    await writeFile(join(nonempty, "child.md"), "child\n", "utf8");
    await writeFile(source, "source\n", "utf8");
    await writeFile(destination, "destination\n", "utf8");

    const plan: FixPlan = {
      operations: [
        { content: "fine\n", path: fine, type: "write" },
        { path: nonempty, type: "remove" },
        { destinationPath: destination, sourcePath: source, type: "move" },
      ],
      summary: "One good operation and two blocked ones.",
    };

    const preview = await previewFixPlan({ model: fixture.model, plan });

    expect(preview.changedOperationCount).toBe(1);
    expect(preview.conflictedOperationCount).toBe(2);
    expect(preview.operations.map((operation) => operation.effect)).toEqual([
      "create",
      "conflict",
      "conflict",
    ]);
    expect(preview.operations[1]?.conflict).toContain("empty directory");
    expect(preview.operations[2]?.conflict).toContain("destination already exists");

    // A blocked plan is refused whole, so the one good operation does not land on its own.
    await expect(executeFixPlan({ model: fixture.model, now, plan })).rejects.toMatchObject({
      code: "plan-blocked",
      operationIndex: 1,
    });
    await expect(lstat(fine)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("accepts a bottom-up group that removes every child before its directories", async () => {
    const fixture = await createFixture();
    const root = join(fixture.workspace, "skill");
    const nested = join(root, "references");
    const skillFile = join(root, "SKILL.md");
    const reference = join(nested, "guide.md");
    await mkdir(nested, { recursive: true });
    await writeFile(skillFile, "skill\n", "utf8");
    await writeFile(reference, "guide\n", "utf8");

    const plan: FixPlan = {
      operations: [
        { path: skillFile, type: "remove" },
        { path: reference, type: "remove" },
        { path: nested, type: "remove" },
        { path: root, type: "remove" },
      ],
      summary: "Remove a complete skill tree.",
    };

    const result = await executeFixPlan({ model: fixture.model, now, plan });

    expect(result.preview.conflictedOperationCount).toBe(0);
    expect(result.appliedOperationCount).toBe(4);
    await expect(lstat(root)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("does not let a nested removal group hide a conflicting child write", async () => {
    const fixture = await createFixture();
    const root = join(fixture.workspace, "skill");
    const removed = join(root, "old.md");
    const written = join(root, "new.md");
    await mkdir(root);
    await writeFile(removed, "old\n", "utf8");

    const plan: FixPlan = {
      operations: [
        { path: removed, type: "remove" },
        { content: "new\n", path: written, type: "write" },
        { path: root, type: "remove" },
      ],
      summary: "Reject mixed nested mutations.",
    };

    await expect(previewFixPlan({ model: fixture.model, plan })).rejects.toMatchObject({
      code: "path-conflict",
      operationIndex: 2,
    });
  });

  it("rolls back a nested removal group when a later operation becomes stale", async () => {
    const fixture = await createFixture();
    const root = join(fixture.workspace, "skill");
    const nested = join(root, "references");
    const skillFile = join(root, "SKILL.md");
    const reference = join(nested, "guide.md");
    const stale = join(fixture.workspace, "stale.md");
    await mkdir(nested, { recursive: true });
    await writeFile(skillFile, "skill\n", "utf8");
    await writeFile(reference, "guide\n", "utf8");
    await writeFile(stale, "before\n", "utf8");
    const plan: FixPlan = {
      operations: [
        { path: skillFile, type: "remove" },
        { path: reference, type: "remove" },
        { path: nested, type: "remove" },
        { path: root, type: "remove" },
        { content: "planned\n", path: stale, type: "write" },
      ],
      summary: "Roll back a stale removal plan.",
    };
    const prepared = await prepareFixPlan({ model: fixture.model, plan });
    await writeFile(stale, "changed\n", "utf8");

    await expect(applyFixPlan(prepared, { now })).rejects.toMatchObject({
      code: "filesystem-changed",
      operationIndex: 4,
      rollback: "complete",
    });

    await expect(readFile(skillFile, "utf8")).resolves.toBe("skill\n");
    await expect(readFile(reference, "utf8")).resolves.toBe("guide\n");
    await expect(readFile(stale, "utf8")).resolves.toBe("changed\n");
  });

  it.skipIf(process.platform === "win32")(
    "reports unsupported filesystem nodes as conflicts",
    async () => {
      const fixture = await createFixture();
      const pipe = join(fixture.workspace, "config.pipe");
      await promisify(execFile)("mkfifo", [pipe]);

      const preview = await previewFixPlan({ model: fixture.model, plan: removePlan(pipe) });

      expect(preview.operations[0]).toMatchObject({
        conflict: "path is not a regular file, directory, or symbolic link",
        effect: "conflict",
      });
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports an unwritable parent as a conflict rather than failing mid-plan",
    async () => {
      const fixture = await createFixture();
      const locked = join(fixture.workspace, "locked");
      await mkdir(locked);
      await chmod(locked, 0o500);
      restoreModes.push(locked);

      const preview = await previewFixPlan({
        model: fixture.model,
        plan: writePlan(join(locked, "blocked.md")),
      });

      expect(preview.operations[0]).toMatchObject({ effect: "conflict" });
      expect(preview.operations[0]?.conflict).toContain("no write permission");
    },
  );

  it("names the allowed roots when a path falls outside every one of them", async () => {
    const fixture = await createFixture();
    const secret = join(fixture.home, ".ssh", "authorized_keys");

    await expect(
      previewFixPlan({ model: fixture.model, plan: writePlan(secret) }),
    ).rejects.toMatchObject({ code: "invalid-path", path: secret });
    await expect(previewFixPlan({ model: fixture.model, plan: writePlan(secret) })).rejects.toThrow(
      join(fixture.home, "agents"),
    );
  });

  it("derives managed home roots from what the adapters declared", async () => {
    const fixture = await createFixture();
    const undeclared = join(fixture.home, "undeclared", "config.md");

    // `~/agents` is declared by the fixture adapter; a sibling directory is not.
    await expect(
      previewFixPlan({ model: fixture.model, plan: writePlan(undeclared) }),
    ).rejects.toMatchObject({ code: "invalid-path", path: undeclared });
  });

  it("refuses to change a file whose previous contents it could not capture", async () => {
    const fixture = await createFixture();
    const huge = join(fixture.workspace, "huge.bin");
    await writeFile(huge, Buffer.alloc(MAX_MUTABLE_FILE_BYTES + 1));

    const preview = await previewFixPlan({ model: fixture.model, plan: writePlan(huge) });

    expect(preview.operations[0]?.effect).toBe("conflict");
    expect(preview.operations[0]?.conflict).toContain("reversible");
  });

  it("refuses a write whose contents were derived from bytes the file no longer has", async () => {
    const fixture = await createFixture();
    const path = join(fixture.workspace, "config.json");
    await writeFile(path, '{"a":1}\n', "utf8");
    const digest = createHash("sha256").update('{"a":1}\n', "utf8").digest("hex");
    const plan: FixPlan = {
      operations: [
        { content: "rewritten", path, precondition: { digest, kind: "sha256" }, type: "write" },
      ],
      summary: "Rewrite a scanned file.",
    };

    const beforeEdit = await previewFixPlan({ model: fixture.model, plan });
    expect(beforeEdit.operations[0]?.effect).toBe("update");

    await writeFile(path, '{"a":2}\n', "utf8");
    const afterEdit = await previewFixPlan({ model: fixture.model, plan });

    expect(afterEdit.operations[0]?.effect).toBe("conflict");
    expect(afterEdit.operations[0]?.conflict).toContain("changed after Aura read it");
    expect(await readFile(path, "utf8")).toBe('{"a":2}\n');
  });

  it("refuses a write that expected to create a file someone else has since created", async () => {
    const fixture = await createFixture();
    const path = join(fixture.workspace, "new.json");
    const plan: FixPlan = {
      operations: [{ content: "{}", path, precondition: { kind: "absent" }, type: "write" }],
      summary: "Create a scanned file.",
    };

    expect((await previewFixPlan({ model: fixture.model, plan })).operations[0]?.effect).toBe(
      "create",
    );
    await writeFile(path, "someone else got here first", "utf8");

    expect((await previewFixPlan({ model: fixture.model, plan })).operations[0]?.effect).toBe(
      "conflict",
    );
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
