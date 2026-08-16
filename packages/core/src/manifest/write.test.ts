import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AuraManifestState, FixPlan } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import {
  assertAuraManifestWritable,
  createAuraManifestWriteOperation,
  createEmptyAuraManifest,
  executeFixPlan,
  parseAuraManifest,
  previewFixPlan,
  undoFixPlan,
} from "../index.js";
import { createFixPlanFixture } from "../fix-plan/testing.js";

describe("Aura manifest writes", () => {
  it("creates, atomically updates, locks, journals, and undoes a mode-0o600 manifest", async () => {
    const fixture = await createFixPlanFixture();
    const path = join(fixture.home, "agents", "aura.json");
    const firstManifest = createEmptyAuraManifest();
    const firstPlan = plan(createAuraManifestWriteOperation(fixture.model.manifest, firstManifest));

    await executeFixPlan({ model: fixture.model, now: () => new Date(1), plan: firstPlan });
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    await chmod(path, 0o644);
    const ready = parseAuraManifest(await readFile(path, "utf8"), path);
    if (ready.status !== "ready") {
      throw new Error("expected a ready manifest");
    }
    const updated = {
      ...ready.value,
      apps: { codex: { managed: true } },
    };
    const model = { ...fixture.model, manifest: ready };
    const result = await executeFixPlan({
      model,
      now: () => new Date(2),
      plan: plan(createAuraManifestWriteOperation(ready, updated)),
    });

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      apps: { codex: { managed: true } },
    });

    await undoFixPlan({ backupId: result.backupId, model, now: () => new Date(3) });
    expect((await stat(path)).mode & 0o777).toBe(0o644);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(firstManifest);
  });

  it("refuses to plan a manifest overwrite from corrupt or unsupported state", async () => {
    const fixture = await createFixPlanFixture();
    const path = fixture.model.manifest.path;
    await mkdir(join(fixture.home, "agents"));
    await writeFile(path, "broken", { encoding: "utf8", flag: "wx", mode: 0o600 });
    const corrupt = parseAuraManifest("broken", path);
    const newer = parseAuraManifest('{"schemaVersion":2}', path);

    for (const state of [corrupt, newer]) {
      expect(() => assertAuraManifestWritable(state)).toThrow(/unchanged|Upgrade Aura/u);
      expect(() => createAuraManifestWriteOperation(state, createEmptyAuraManifest())).toThrow(
        /unchanged|Upgrade Aura/u,
      );
    }
    await expect(readFile(path, "utf8")).resolves.toBe("broken");
  });

  it.each([
    parseAuraManifest("broken", "/home/dev/agents/aura.json"),
    parseAuraManifest('{"schemaVersion":2}', "/home/dev/agents/aura.json"),
  ])("blocks real fixes but permits dry-run previews for read-only state", async (manifest) => {
    const fixture = await createFixPlanFixture();
    const target = join(fixture.home, "agents", "note.md");
    const model = {
      ...fixture.model,
      manifest: atFixturePath(manifest, fixture.model.manifest.path),
    };
    const request = {
      model,
      now: () => new Date(4),
      plan: plan({ content: "note\n", path: target, type: "write" }),
    };

    const dryRun = await executeFixPlan({ ...request, dryRun: true });
    expect(dryRun).toMatchObject({ appliedOperationCount: 0, dryRun: true });
    // The preview a user confirms has to say the plan cannot run, rather than rendering an
    // applicable-looking diff and failing at the last step.
    expect(dryRun.preview.conflictedOperationCount).toBe(1);
    expect(dryRun.preview.operations[0]?.conflict).toMatch(/Aura left it unchanged|Upgrade Aura/u);

    // `manifestProblem` rather than prose: an unsupported version asks the user to upgrade Aura,
    // corrupt JSON asks them to repair a file, and a caller has to be able to tell those apart.
    await expect(executeFixPlan(request)).rejects.toMatchObject({
      code: "manifest-read-only",
      manifestProblem: { kind: manifest.status === "read-only" ? manifest.problem.kind : "" },
      path: fixture.model.manifest.path,
    });
    await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves an existing file's mode alone however hard a plan asks", async () => {
    const fixture = await createFixPlanFixture();
    const target = join(fixture.workspace, "notes.md");
    await writeFile(target, "before\n", { encoding: "utf8", flag: "wx", mode: 0o600 });

    const result = await executeFixPlan({
      model: fixture.model,
      now: () => new Date(5),
      plan: plan({ content: "after\n", mode: 0o755, path: target, type: "write" }),
    });

    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(await readFile(target, "utf8")).toBe("after\n");
    expect(result.preview.operations[0]?.diff).toContain("mode 0o755 requested");
    expect(result.preview.operations[0]?.diff).toContain("0o600 is preserved");
  });

  it("blocks a mode outside the permitted set", async () => {
    const fixture = await createFixPlanFixture();
    const target = join(fixture.workspace, "hook.sh");
    // Parsed rather than written as a literal: `FileMode` is closed at compile time, and the point
    // is what reaches the kernel from a plugin that shipped as untyped JavaScript.
    const untyped: FixPlan = JSON.parse(
      JSON.stringify({
        operations: [{ content: "#!/bin/sh\n", mode: 0o4755, path: target, type: "write" }],
        summary: "Write a setuid file.",
      }),
    );

    const preview = await previewFixPlan({ model: fixture.model, plan: untyped });

    expect(preview.conflictedOperationCount).toBe(1);
    expect(preview.operations[0]?.conflict).toBe("mode 0o4755 is not a permitted file mode");
    await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function plan(operation: FixPlan["operations"][number]): FixPlan {
  return { operations: [operation], summary: "Write test state." };
}

function atFixturePath(state: AuraManifestState, path: string): AuraManifestState {
  if (state.status !== "read-only") {
    throw new Error("expected read-only state");
  }
  return { ...state, path };
}
