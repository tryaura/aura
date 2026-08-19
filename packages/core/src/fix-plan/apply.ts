import { applyArchive, applyMove, applyRemove } from "./apply-basic.js";
import { applySymlink, applyWrite } from "./apply-replacement.js";
import type { RegisterUndo } from "./apply-support.js";
import { NODE_MUTATION_FILE_SYSTEM, type MutationFileSystem } from "./filesystem.js";
import type { ApplicableOperation, PreparedPlanState } from "./prepared.js";

/** The only function in the kernel that turns a prepared fix operation into filesystem writes. */
export async function applyPreparedOperation(
  prepared: ApplicableOperation,
  plan: PreparedPlanState,
  registerUndo: RegisterUndo,
  filesystem: MutationFileSystem = NODE_MUTATION_FILE_SYSTEM,
): Promise<void> {
  switch (prepared.type) {
    case "archive": {
      return applyArchive(prepared, plan, registerUndo, filesystem);
    }
    case "move": {
      return applyMove(prepared, plan, registerUndo, filesystem);
    }
    case "remove": {
      return applyRemove(prepared, plan, registerUndo, filesystem);
    }
    case "symlink": {
      return applySymlink(prepared, plan, registerUndo, filesystem);
    }
    case "write": {
      return applyWrite(prepared, plan, registerUndo, filesystem);
    }
  }
}
