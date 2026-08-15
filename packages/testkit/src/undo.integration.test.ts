import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkspaceModel } from "@tryaura/aura-sdk";
import { executeFixPlan, undoLastFixPlan } from "@tryaura/core";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("persistent undo integration", () => {
  it("restores a seeded filesystem from a fresh core invocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "aura-testkit-undo-"));
    temporaryDirectories.push(root);
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const agents = join(home, "agents");
    await mkdir(agents, { recursive: true });
    await mkdir(workspace);
    const updated = join(workspace, "updated.md");
    const removed = join(workspace, "removed.md");
    const source = join(workspace, "source.md");
    const destination = join(workspace, "archive", "source.md");
    const link = join(workspace, "nested", "AGENTS.md");
    const shared = join(agents, "AGENTS.md");
    await writeFile(shared, "shared\n", "utf8");
    await writeFile(updated, "before\n", "utf8");
    await chmod(updated, 0o600);
    await writeFile(removed, "removed\n", "utf8");
    await writeFile(source, "source\n", "utf8");
    const model = workspaceModel(home, workspace, shared);
    const now = (): Date => new Date("2026-08-15T01:02:03.004Z");

    await executeFixPlan({
      model,
      now,
      plan: {
        operations: [
          { content: "after\n", path: updated, type: "write" },
          { path: removed, type: "remove" },
          { destinationPath: destination, sourcePath: source, type: "move" },
          { path: link, target: shared, type: "symlink" },
        ],
        summary: "Seed persistent undo.",
      },
    });

    const result = await undoLastFixPlan({ homeDir: home, now });

    expect(result).toMatchObject({ restoredOperationCount: 4, status: "undone" });
    await expect(readFile(updated, "utf8")).resolves.toBe("before\n");
    expect((await lstat(updated)).mode & 0o777).toBe(0o600);
    await expect(readFile(removed, "utf8")).resolves.toBe("removed\n");
    await expect(readFile(source, "utf8")).resolves.toBe("source\n");
    await expect(lstat(destination)).rejects.toHaveProperty("code", "ENOENT");
    await expect(readlink(link)).rejects.toHaveProperty("code", "ENOENT");
  });
});

function workspaceModel(homeDir: string, cwd: string, shared: string): WorkspaceModel {
  return {
    apps: [
      {
        adapterId: "testkit",
        detection: { installed: true },
        displayName: "Testkit",
        instructionFiles: [],
        mcpServers: [],
        skills: [],
        sourceFiles: [
          {
            exists: true,
            spec: { id: "instructions", kind: "instructions", path: shared, scope: "global" },
          },
        ],
        support: { status: "supported", supportedRange: "*" },
      },
    ],
    cwd,
    homeDir,
    instructionFiles: [],
    mcpServers: [],
    projectRoot: cwd,
    skills: [],
  };
}
