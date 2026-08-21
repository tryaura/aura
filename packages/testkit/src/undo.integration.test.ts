import { chmod, lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";

import type { WorkspaceModel } from "@tryaura/aura-sdk";
import { createWorkspaceModel } from "@tryaura/aura-sdk/testing";
import { executeFixPlan, undoFixPlan } from "@tryaura/core";
import { describe, expect, it } from "vitest";

import { createSeedBuilder } from "./index.js";

describe("persistent undo integration", () => {
  it("restores a seeded filesystem from a fresh core invocation", async () => {
    await using seed = await createSeedBuilder()
      .homeFile("agents/AGENTS.md", "shared\n")
      .homeFile("agents/fixture/updated.md", "before\n")
      .homeFile("agents/fixture/removed.md", "removed\n")
      .homeFile("agents/fixture/source.md", "source\n")
      .build();
    const home = seed.homeDir;
    const workspace = seed.workspaceDir;
    const agents = join(home, "agents");
    const updated = join(agents, "fixture", "updated.md");
    const removed = join(agents, "fixture", "removed.md");
    const source = join(agents, "fixture", "source.md");
    const destination = join(agents, "fixture", "archive", "source.md");
    const link = join(agents, "fixture", "nested", "AGENTS.md");
    const shared = join(agents, "AGENTS.md");
    await chmod(updated, 0o600);
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

    const result = await undoFixPlan({ model, now });

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
  return createWorkspaceModel({
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
    manifest: {
      exists: false,
      path: join(homeDir, "agents", "aura.json"),
      status: "missing",
    },
    sharedInstructions: { content: "after\n", exists: true, path: shared },
    projectRoot: cwd,
  });
}
