import { defineCheck, type DetectedFinding, type WorkspaceModel } from "@tryaura/aura-sdk";

import { sha256 } from "../hashing.js";
import { displayInstructionPath } from "../instruction-paths.js";
import { CONTRADICTION_AXES } from "./axes.js";
import {
  collectAxisHits,
  findAxisConflicts,
  isCrossScopeConflict,
  type AxisConflict,
} from "./hits.js";

export const contradictoryInstructionsCheck = defineCheck({
  defaultSeverity: "info",
  detect: detectContradictoryInstructions,
  explain: `Conflicting instructions leave an agent guessing which rule to follow, and the winner can change with file loading order. The same request can therefore produce different behavior across applications or repositories.

Inspect the locations in each finding and keep one preference for the topic. When both rules are intentional, rewrite the narrower rule so its scope or conditions are explicit.`,
  fixability: "manual",
  id: "INS-005",
  scope: "global",
  title: "Instruction guidance does not contradict itself",
});

function detectContradictoryInstructions(model: WorkspaceModel): readonly DetectedFinding[] {
  return (
    findAxisConflicts(collectAxisHits(model.instructionFiles))
      // A conflict between a global and a project file is INS-008's to report, with the precedence
      // remediation this check cannot give.
      .filter((conflict) => !isCrossScopeConflict(conflict))
      .map((conflict) => findingForConflict(conflict, model))
  );
}

function findingForConflict(conflict: AxisConflict, model: WorkspaceModel): DetectedFinding {
  const axis = CONTRADICTION_AXES.find((candidate) => candidate.id === conflict.axis);
  const label = axis?.label ?? conflict.axis;
  const describe = axis?.describePolarity ?? ((polarity: string) => polarity);
  const left = displayInstructionPath(conflict.left.path, model);
  const right = displayInstructionPath(conflict.right.path, model);
  return {
    details: `Locations: ${left}:${String(conflict.left.line)} says ${describe(conflict.left.polarity)}; ${right}:${String(conflict.right.line)} says ${describe(conflict.right.polarity)}.`,
    id: `axis:${conflict.axis}:${sha256(`${conflict.left.path}\0${conflict.right.path}`)}`,
    locations: [
      { line: conflict.left.line, path: conflict.left.path },
      { line: conflict.right.line, path: conflict.right.path },
    ],
    message: `Instruction files disagree about ${label} guidance.`,
    metadata: {
      axis: conflict.axis,
      left: {
        line: conflict.left.line,
        path: conflict.left.path,
        polarity: conflict.left.polarity,
      },
      right: {
        line: conflict.right.line,
        path: conflict.right.path,
        polarity: conflict.right.polarity,
      },
    },
  };
}
