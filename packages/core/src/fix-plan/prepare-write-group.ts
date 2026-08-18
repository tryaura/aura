import { Buffer } from "node:buffer";

import type { WriteFileOperation } from "@tryaura/aura-sdk";

import {
  captureBefore,
  type CapturedState,
  findUnwritablePath,
  spendBudget,
  type RetentionBudget,
} from "./capture.js";
import { mergeWriteContents } from "./merge-writes.js";
import type { ValidatedOperation } from "./path-policy.js";
import { resolveWriteMode, type EnforcedModes } from "./prepare-modes.js";
import { conflict, createPreview, noop, type PreparedOperation } from "./prepared.js";
import { isCapturedFile } from "./state.js";
import { unmetPrecondition, writeRejection } from "./write-validation.js";
import { renderRedactedWriteDiff } from "./write-redaction.js";

type WritableBefore = Exclude<CapturedState, { readonly kind: "directory" }>;

/** Captures and coalesces complete-file writes that were independently built from one source. */
export async function prepareWriteGroup(
  group: readonly ValidatedOperation[],
  budget: RetentionBudget,
  enforcedMode: EnforcedModes,
): Promise<PreparedOperation> {
  const leader = group[0];
  if (leader === undefined || leader.operation.type !== "write") {
    throw new Error("A coalesced write group must start with a write operation.");
  }
  const writes = group.flatMap((candidate) =>
    candidate.operation.type === "write" ? [candidate.operation] : [],
  );
  const rejected = writeGroupRejection(writes);
  if (rejected !== undefined) {
    return conflict(leader, rejected);
  }

  const blocked = await findUnwritablePath(leader);
  if (blocked !== undefined) {
    return conflict(leader, blocked);
  }
  const captured = await captureBefore(leader, leader.operation.path, budget, "written over");
  if ("conflict" in captured) {
    return conflict(leader, captured.conflict);
  }
  const before = captured.state;
  if (before.kind === "directory") {
    return conflict(leader, "cannot replace a directory with a file");
  }

  const unmet = unmetPrecondition(writes, before);
  if (unmet !== undefined) {
    return conflict(leader, unmet);
  }

  const mode = compatibleMode(writes, before, enforcedMode);
  if (mode === undefined) {
    return conflict(leader, "same-path writes request incompatible file modes");
  }

  const merged = mergeContents(before, writes);
  if (merged.status === "conflict") {
    return conflict(leader, merged.reason);
  }
  const operation: WriteFileOperation = { ...leader.operation, content: merged.content };
  const mergedContent = Buffer.from(merged.content, "utf8");
  // Merging is additive, so a group whose members each clear the per-operation ceiling can still
  // combine into a result that does not. The ceiling doubles as what one operation may retain for
  // undo, so the synthesized write has to answer for it too.
  const rejectedMerge = writeRejection(operation, mergedContent);
  if (rejectedMerge !== undefined) {
    return conflict(leader, `after merging same-path writes, ${rejectedMerge}`);
  }

  const mergedLeader: ValidatedOperation = { ...leader, operation };
  if (isCapturedFile(before) && before.content.equals(mergedContent) && before.mode === mode) {
    return noop(mergedLeader);
  }

  spendBudget(budget, before);
  return {
    before,
    mode,
    operation,
    preview: createPreview(
      mergedLeader,
      before.kind === "missing" ? "create" : "update",
      renderRedactedWriteDiff(
        writes,
        operation.path,
        before,
        operation.content,
        operation.mode,
        mode,
      ),
    ),
    type: "write",
  };
}

function writeGroupRejection(writes: readonly WriteFileOperation[]): string | undefined {
  for (const write of writes) {
    const rejected = writeRejection(write, Buffer.from(write.content, "utf8"));
    if (rejected !== undefined) {
      return rejected;
    }
  }
  return undefined;
}

function compatibleMode(
  writes: readonly WriteFileOperation[],
  before: WritableBefore,
  enforcedMode: EnforcedModes,
): number | undefined {
  const modes = new Set(writes.map((write) => resolveWriteMode(write, before, enforcedMode)));
  return modes.size === 1 ? [...modes][0] : undefined;
}

function mergeContents(
  before: CapturedState,
  writes: readonly WriteFileOperation[],
): ReturnType<typeof mergeWriteContents> {
  if (isCapturedFile(before)) {
    const base = before.content.toString("utf8");
    if (!Buffer.from(base, "utf8").equals(before.content)) {
      return {
        reason: "same-path writes cannot merge a file that is not valid UTF-8",
        status: "conflict",
      };
    }
    return mergeWriteContents(
      base,
      writes.map((write) => write.content),
    );
  }

  const targets = [...new Set(writes.map((write) => write.content))];
  return targets.length === 1
    ? { content: targets[0] ?? "", status: "merged" }
    : {
        reason: "same-path writes create or replace a non-file with different contents",
        status: "conflict",
      };
}
