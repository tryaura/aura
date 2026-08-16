import { createHash } from "node:crypto";
import { resolve } from "node:path";

import {
  defineCheck,
  type DetectedFinding,
  type Finding,
  type FixPlan,
  type InstructionDocument,
} from "@tryaura/aura-sdk";

interface LegacyDocument {
  readonly document: InstructionDocument;
  readonly tool: string;
}

export const legacyInstructionsCheck = defineCheck({
  defaultSeverity: "warn",
  detect: (model) => legacyDocuments(model.instructionFiles).map(toFinding),
  explain: `Legacy instruction files are easy to forget after changing agent applications or configuration formats. They may still be loaded unexpectedly, or hold useful guidance that newer application files never received.

Re-run the check with \`--fix --interactive\` to review the suggested migration steps, then use the \`setup\` command to consolidate selected content. Aura archives originals through its reversible backup history instead of deleting them silently.`,
  fix: guidedFix,
  fixability: "guided",
  id: "INS-004",
  scope: "global",
  title: "Legacy instruction files are consolidated",
});

function legacyDocuments(documents: readonly InstructionDocument[]): readonly LegacyDocument[] {
  const byPath = new Map<string, LegacyDocument>();
  for (const document of documents) {
    const tool = legacyTool(document);
    const path = resolve(document.path);
    if (tool !== undefined && !byPath.has(path)) {
      byPath.set(path, { document, tool });
    }
  }
  return [...byPath.values()].sort((left, right) =>
    resolve(left.document.path).localeCompare(resolve(right.document.path)),
  );
}

function legacyTool(document: InstructionDocument): string | undefined {
  if (document.metadata?.["legacy"] !== true) {
    return undefined;
  }
  const tool = document.metadata["tool"];
  return typeof tool === "string" ? tool : undefined;
}

function toFinding(legacy: LegacyDocument): DetectedFinding {
  const path = resolve(legacy.document.path);
  return {
    details: `Consolidate the useful guidance into the shared instructions, then archive the original through Aura setup.`,
    id: `legacy:${pathHash(path)}`,
    locations: [{ path }],
    message: `${displayTool(legacy.tool)} legacy instructions remain at ${path}.`,
    metadata: { legacy: true, tool: legacy.tool },
  };
}

function guidedFix(finding: Finding): FixPlan | undefined {
  if (finding.metadata?.["legacy"] !== true) {
    return undefined;
  }
  const path = finding.locations?.[0]?.path;
  if (path === undefined) {
    return undefined;
  }
  return {
    manualSteps: [
      `Run \`aura setup\` and choose instruction consolidation to migrate ${path} into the shared instructions.`,
      "Confirm setup archived the original, then run `aura check` again.",
    ],
    operations: [],
    summary: `Consolidate the legacy instruction file at ${path}.`,
  };
}

function pathHash(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

function displayTool(tool: string): string {
  return tool
    .split("-")
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}
