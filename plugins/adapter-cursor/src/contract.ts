import { extname } from "node:path";

import { type InstructionDocument } from "@tryaura/aura-sdk";

/**
 * The names this adapter puts into the workspace model, published for checks to read.
 *
 * A check that reached for these as string literals would keep compiling after a rename here and
 * silently stop finding anything, so the contract is exported and imported rather than retyped.
 *
 * `rulesProject` names the `.cursor/rules` directory slot; each discovered child file gets a
 * derived id of the form `cursor.rules.project/<encoded-name>`, and `aura` is the derived id
 * reserved for the rule Aura itself maintains there.
 */
export const CURSOR_SOURCE_IDS = Object.freeze({
  agents: "cursor.rules.project.agents",
  aura: "cursor.rules.project/aura-owned",
  legacyRules: "cursor.rules.project.legacy",
  mcpGlobal: "cursor.mcp.global",
  mcpProject: "cursor.mcp.project",
  rulesProject: "cursor.rules.project",
});

export const CURSOR_ADAPTER_ID = "cursor";

/**
 * Whether Cursor attaches this rule only conditionally rather than in every conversation.
 *
 * Cursor always-loads an `.mdc` rule only when its frontmatter opts in with `alwaysApply: true`;
 * every other rule attaches by description or glob. Which frontmatter means what is this adapter's
 * knowledge, so the predicate is published here for checks that reason about what is actually
 * loaded, instead of each check re-reading Cursor's frontmatter rules for itself.
 */
export function isConditionalCursorRule(document: InstructionDocument): boolean {
  return (
    extname(document.path).toLowerCase() === ".mdc" && document.metadata?.["alwaysApply"] !== true
  );
}
