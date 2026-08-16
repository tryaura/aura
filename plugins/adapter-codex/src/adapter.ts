import { join } from "node:path";

import {
  defineAdapter,
  detectExecutable,
  type AdapterDetection,
  type AdapterFileMap,
  type AdapterFileSpec,
  type AdapterProblem,
  type AdapterSourceFile,
  type Environment,
  type Scope,
} from "@tryaura/aura-sdk";

import {
  CODEX_ADAPTER_ID,
  CODEX_OVERRIDE_SUFFIX,
  CODEX_PROJECT_TRUST_KEY,
  codexProjectInstructionsId,
  CODEX_SOURCE_IDS as SOURCE_IDS,
} from "./contract.js";
import { selectInstructionFiles } from "./instructions.js";
import { parseMcpServers } from "./mcp.js";
import { projectDirectories } from "./project-directories.js";
import { parseProjectTrust } from "./trust.js";

export const codexAdapter = defineAdapter({
  detect: (environment) =>
    detectExecutable(environment, { authenticationArgs: ["login", "status"], binaryName: "codex" }),
  displayName: "Codex",
  files: codexFiles,
  id: CODEX_ADAPTER_ID,
  installHint:
    "Run `npm install -g @openai/codex@latest`, or update Codex with your package manager.",
  parse: ({ cwd, files, projectRoot }) => {
    const mcp = files.get(SOURCE_IDS.mcp);
    const instructions = selectInstructionFiles(files);

    return {
      instructionFiles: instructions.documents,
      mcpServers: mcp?.content === undefined ? [] : parseMcpServers(mcp),
      metadata: {
        [CODEX_PROJECT_TRUST_KEY]:
          mcp === undefined ? "unknown" : parseProjectTrust(mcp, { cwd, projectRoot }),
      },
      problems: shadowedEntryProblems(instructions.shadowed),
      skills: [],
    };
  },
  sharedLink: {
    entryPath: "~/.codex/AGENTS.md",
    kind: "symlink",
  },
  // Verified releases only: Codex ships breaking changes in 0.x minors, so the range widens one
  // verified version at a time rather than trusting a whole major like Claude Code's does.
  supportedRange: ">=0.146.0 <0.148.0",
});

/**
 * Reports an override that shadows the file Aura's own shared link writes to.
 *
 * A repository shadowing its own `AGENTS.md` is ordinary and says nothing. `~/.codex/AGENTS.md` is
 * different: it is the entry INS-002 links to the shared instruction source, so an override beside
 * it means Aura can wire that link up perfectly and Codex will still never read it. Nothing in the
 * model shows that on its own — the link is present, valid, and pointed at exactly the right file.
 */
function shadowedEntryProblems(shadowed: readonly AdapterSourceFile[]): readonly AdapterProblem[] {
  return shadowed
    .filter((file) => file.spec.id === SOURCE_IDS.instructions)
    .map((file) => ({
      message: `Codex reads AGENTS.override.md instead of ${file.spec.path}, so whatever that file loads — including Aura's shared instruction link — is not reaching Codex. Move the guidance into the override file, or remove it.`,
      sourceId: file.spec.id,
    }));
}

/**
 * Declares the global and project configuration Codex reads, in the order Codex reads it.
 *
 * Project instructions are not one file. Codex starts at the repository root and walks *down* to
 * the invocation directory, taking at most one `AGENTS.md` per directory and concatenating them
 * root-first. Declaring only the invocation directory would therefore miss the repository's own
 * `AGENTS.md` for every scan started from a package inside a monorepo — the common case, and the
 * one where the guidance Codex is actually loading is the guidance Aura would never see. The walk
 * stops where Codex stops: nothing below the invocation directory is read, by Codex or here.
 *
 * Every level declares its `AGENTS.override.md` beside its `AGENTS.md`, because Codex prefers the
 * override wherever it finds one. Which of the two actually applies is decided in
 * {@link selectInstructionFiles}, once core has said what is really on disk.
 *
 * One limit is deliberately not modelled: Codex stops concatenating once the combined instructions
 * reach `project_doc_max_bytes` (32 KiB by default), so a very large set is not loaded in full.
 * Aura reports the files Codex reads, not the prefix of them that survives its budget.
 */
function codexFiles(
  environment: Environment,
  _detection: AdapterDetection,
  _files: AdapterFileMap,
  projectRoot: string | undefined,
): readonly AdapterFileSpec[] {
  const codexHome = join(environment.homeDir, ".codex");

  return [
    ...instructionLevel(codexHome, SOURCE_IDS.instructions, "global"),
    // The walk hands back the invocation directory first, so its index is the ancestor count the
    // slot id is named for. Reversed afterwards because Codex reads the outermost directory first.
    ...projectDirectories({ cwd: environment.cwd, projectRoot })
      .map((directory, ancestors) =>
        instructionLevel(directory, codexProjectInstructionsId(ancestors), "project"),
      )
      .reverse()
      .flat(),
    {
      id: SOURCE_IDS.mcp,
      kind: "mcp",
      optional: true,
      path: join(codexHome, "config.toml"),
      scope: "global",
    },
  ];
}

/** The two candidate instruction files one directory can supply, in Codex's preference order. */
function instructionLevel(directory: string, id: string, scope: Scope): readonly AdapterFileSpec[] {
  return [
    {
      id: `${id}${CODEX_OVERRIDE_SUFFIX}`,
      kind: "instructions",
      optional: true,
      path: join(directory, "AGENTS.override.md"),
      scope,
    },
    {
      id,
      kind: "instructions",
      optional: true,
      path: join(directory, "AGENTS.md"),
      scope,
    },
  ];
}
