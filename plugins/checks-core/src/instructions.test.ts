import type { FileProblem } from "@tryaura/aura-sdk";
import { SHARED_INSTRUCTIONS_TEMPLATE } from "@tryaura/content-official";
import { describe, expect, it } from "vitest";

import { onlyFinding, SHARED_PATH, workspace } from "./testing.js";
import { sharedInstructionsCheck } from "./instructions.js";

describe("INS-001", () => {
  it("passes for non-whitespace shared instructions", () => {
    expect(sharedInstructionsCheck.detect(workspace([], "# Shared\n"))).toEqual([]);
  });

  it.each([
    ["missing", false, undefined],
    ["empty", true, "  \n"],
  ])("fixes a %s shared instruction source", (_case, exists, content) => {
    const model = workspace([], content, { exists });
    const finding = onlyFinding(sharedInstructionsCheck, model);

    expect(sharedInstructionsCheck.fix(finding, model)).toEqual({
      operations: [
        {
          content: SHARED_INSTRUCTIONS_TEMPLATE,
          mode: 0o644,
          path: SHARED_PATH,
          type: "write",
        },
      ],
      summary: "Create the shared instruction source.",
    });
  });

  it.each(["denied", "too-large", "unsupported"] satisfies readonly FileProblem[])(
    "reports but does not overwrite a %s source",
    (problem) => {
      const model = workspace([], undefined, { exists: true, problem });
      const finding = onlyFinding(sharedInstructionsCheck, model);

      expect(finding.details).toContain(problem);
      expect(sharedInstructionsCheck.fix(finding, model)).toBeUndefined();
    },
  );
});
