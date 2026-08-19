import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { FixPlan } from "@tryaura/aura-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { applyFixPlan, prepareFixPlan } from "./execute.js";
import { NODE_MUTATION_FILE_SYSTEM, type MutationFileSystem } from "./filesystem.js";
import { backupRoot } from "./journal-paths.js";
import { readJournal } from "./journal-read.js";
import { createFixPlanFixture, type FixPlanFixture } from "./testing.js";
import { FixPlanApplyError, type FixPlanRollbackStatus } from "./types.js";

const temporaryDirectories: string[] = [];

const now = (): Date => new Date("2026-02-01T00:00:00.000Z");

interface FaultOutcome {
  /** Operations the executor reports as still applied once it finished unwinding. */
  readonly remaining: number;
  readonly rollback: FixPlanRollbackStatus;
  /** Status the journal entry was left in, or undefined when no entry survived. */
  readonly status: string | undefined;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("fix-plan mutation fault unwind", () => {
  it("removes parents created before a move fails", async () => {
    const fixture = await createFixture();
    const source = join(fixture.workspace, "source.md");
    const destination = join(fixture.workspace, "nested", "destination.md");
    await writeFile(source, "source\n", "utf8");

    const result = await failPlan(
      fixture,
      plan([{ destinationPath: destination, sourcePath: source, type: "move" }]),
      2,
    );

    expect(result).toEqual({ remaining: 0, rollback: "complete", status: "aborted" });
    await expect(readFile(source, "utf8")).resolves.toBe("source\n");
    await expect(lstat(join(fixture.workspace, "nested"))).rejects.toHaveProperty("code", "ENOENT");
  });

  it("removes parents and temporary links when symlink replacement fails", async () => {
    const fixture = await createFixture();
    const target = join(fixture.workspace, "target.md");
    const path = join(fixture.workspace, "nested", "link.md");
    await writeFile(target, "target\n", "utf8");

    const result = await failPlan(fixture, plan([{ path, target, type: "symlink" }]), 3);

    expect(result).toEqual({ remaining: 0, rollback: "complete", status: "aborted" });
    await expect(lstat(path)).rejects.toHaveProperty("code", "ENOENT");
    await expect(lstat(join(fixture.workspace, "nested"))).rejects.toHaveProperty("code", "ENOENT");
  });

  it("removes a created write and its parents when exact chmod fails", async () => {
    const fixture = await createFixture();
    const path = join(fixture.workspace, "nested", "config.md");

    const result = await failPlan(
      fixture,
      plan([{ content: "created\n", path, type: "write" }]),
      3,
    );

    expect(result).toEqual({ remaining: 0, rollback: "complete", status: "aborted" });
    await expect(lstat(path)).rejects.toHaveProperty("code", "ENOENT");
    await expect(lstat(join(fixture.workspace, "nested"))).rejects.toHaveProperty("code", "ENOENT");
  });

  it("keeps archive, remove, and replacement targets unchanged when their calls fail", async () => {
    const fixture = await createFixture();
    const archived = join(fixture.workspace, "archive.md");
    const removed = join(fixture.workspace, "remove.md");
    const replaced = join(fixture.workspace, "replace.md");
    await Promise.all([
      writeFile(archived, "archive\n", "utf8"),
      writeFile(removed, "remove\n", "utf8"),
      writeFile(replaced, "before\n", "utf8"),
    ]);

    await failPlan(
      fixture,
      plan([
        {
          path: archived,
          relativePath: "archive.md",
          replacement: { content: "wrapper\n", type: "write" },
          type: "archive",
        },
      ]),
      3,
    );
    await failPlan(fixture, plan([{ path: removed, type: "remove" }]), 1);
    await failPlan(fixture, plan([{ content: "after\n", path: replaced, type: "write" }]), 3);

    await expect(readFile(archived, "utf8")).resolves.toBe("archive\n");
    await expect(readFile(removed, "utf8")).resolves.toBe("remove\n");
    await expect(readFile(replaced, "utf8")).resolves.toBe("before\n");
  });

  it("unwinds the current partial write together with an earlier operation", async () => {
    const fixture = await createFixture();
    const first = join(fixture.workspace, "first.md");
    const second = join(fixture.workspace, "nested", "second.md");

    const result = await failPlan(
      fixture,
      plan([
        { content: "first\n", path: first, type: "write" },
        { content: "second\n", path: second, type: "write" },
      ]),
      6,
    );

    expect(result).toEqual({ remaining: 0, rollback: "complete", status: "aborted" });
    await expect(lstat(first)).rejects.toHaveProperty("code", "ENOENT");
    await expect(lstat(second)).rejects.toHaveProperty("code", "ENOENT");
  });
});

/**
 * Applies through the real executor with one mutation call failed.
 *
 * Deliberately not a hand-rolled loop over `applyPreparedOperation`: what these cases are about is
 * what the executor does with a failure — unwind, then mark the journal entry so a later undo does
 * not offer work that is no longer on disk — and that only happens in `applyFixPlan`.
 */
async function failPlan(
  fixture: FixPlanFixture,
  fixPlan: FixPlan,
  failureCall: number,
): Promise<FaultOutcome> {
  const prepared = await prepareFixPlan({ model: fixture.model, plan: fixPlan });
  const failure = await applyFixPlan(prepared, { now }, failingFileSystem(failureCall)).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(FixPlanApplyError);
  if (!(failure instanceof FixPlanApplyError)) {
    throw failure;
  }
  return {
    remaining: failure.appliedOperationCount,
    rollback: failure.rollback,
    status: await journalStatus(fixture),
  };
}

async function journalStatus(fixture: FixPlanFixture): Promise<string | undefined> {
  for await (const entry of readJournal(backupRoot(fixture.home), fixture.home)) {
    if (entry.kind !== "unreadable") {
      return entry.handle.manifest.status;
    }
  }
  return undefined;
}

function failingFileSystem(failureCall: number): MutationFileSystem {
  let callCount = 0;
  const run = async <Result>(action: () => Promise<Result>): Promise<Result> => {
    callCount += 1;
    if (callCount === failureCall) {
      throw new Error(`injected mutation failure ${String(failureCall)}`);
    }
    return action();
  };

  return {
    chmod: (path, mode) => run(() => NODE_MUTATION_FILE_SYSTEM.chmod(path, mode)),
    chmodNoFollow: (path, mode) => run(() => NODE_MUTATION_FILE_SYSTEM.chmodNoFollow(path, mode)),
    mkdir: (path, options) => run(() => NODE_MUTATION_FILE_SYSTEM.mkdir(path, options)),
    rename: (source, destination) =>
      run(() => NODE_MUTATION_FILE_SYSTEM.rename(source, destination)),
    rm: (path, options) => run(() => NODE_MUTATION_FILE_SYSTEM.rm(path, options)),
    rmdir: (path) => run(() => NODE_MUTATION_FILE_SYSTEM.rmdir(path)),
    symlink: (target, path) => run(() => NODE_MUTATION_FILE_SYSTEM.symlink(target, path)),
    unlink: (path) => run(() => NODE_MUTATION_FILE_SYSTEM.unlink(path)),
    utimes: (path, accessTime, modifiedTime) =>
      run(() => NODE_MUTATION_FILE_SYSTEM.utimes(path, accessTime, modifiedTime)),
    writeFile: (path, content, options) =>
      run(() => NODE_MUTATION_FILE_SYSTEM.writeFile(path, content, options)),
  };
}

function plan(operations: FixPlan["operations"]): FixPlan {
  return { operations, summary: "Exercise injected mutation failure." };
}

async function createFixture(): Promise<FixPlanFixture> {
  const fixture = await createFixPlanFixture();
  temporaryDirectories.push(fixture.root);
  return fixture;
}
