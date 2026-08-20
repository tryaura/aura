import type {
  AdapterPathKind,
  AppModel,
  InstructionDocument,
  ResolvedSharedLink,
  WorkspaceModel,
} from "@tryaura/aura-sdk";
import { createWorkspaceModel } from "@tryaura/aura-sdk/testing";
import { describe, expect, it } from "vitest";

import { planSharedInstructionLink } from "./shared-link-plan.js";

const SHARED_PATH = "/home/dev/agents/AGENTS.md";
const ENTRY_PATH = "/home/dev/.codex/AGENTS.md";

describe("planSharedInstructionLink convergence", () => {
  it("plans nothing when a symlink already points at the target", () => {
    const outcome = plan({ pathKind: "symlink", symlinkTarget: SHARED_PATH });

    expect(operations(outcome)).toEqual([]);
  });

  // `readlink` returns the target verbatim, so an equivalent spelling must not re-plan the link.
  it("treats a non-canonically spelled symlink target as converged", () => {
    const outcome = plan({
      pathKind: "symlink",
      symlinkTarget: "/home/dev/agents/../agents/./AGENTS.md",
    });

    expect(operations(outcome)).toEqual([]);
  });

  it("plans the symlink when it points somewhere else", () => {
    const outcome = plan({ pathKind: "symlink", symlinkTarget: "/home/dev/elsewhere.md" });

    expect(operations(outcome)).toMatchObject([{ target: SHARED_PATH, type: "symlink" }]);
  });

  /*
   * The caller passes `sourceContent` for a path it is archiving in the same plan, and setup uses
   * the returned operation as that archive's replacement. Reporting convergence from the state the
   * archive is about to move away would leave the archive with no replacement, which removes the
   * app's entry outright.
   */
  it("still plans the symlink when the caller is replacing the entry", () => {
    const outcome = plan(
      { pathKind: "symlink", symlinkTarget: SHARED_PATH },
      { sourceContent: "" },
    );

    expect(operations(outcome)).toMatchObject([{ target: SHARED_PATH, type: "symlink" }]);
  });

  /*
   * The migration an app makes when it stops declaring an import line and starts declaring a link.
   * Every machine already wired the old way holds a real file at the entry, and it is Aura's own:
   * consolidation has no source to offer for it, so refusing it as user-owned would strand the app
   * on that machine for good. Text of the user's around the block is still refused.
   */
  it("replaces an entry holding only a managed block", () => {
    const outcome = plan({
      content: [
        "<!-- aura:begin -->",
        `<!-- aura:begin id=shared-instructions sha256=${"0".repeat(64)} -->`,
        "@~/agents/AGENTS.md",
        "<!-- aura:end id=shared-instructions -->",
        "<!-- aura:end -->",
        "",
      ].join("\n"),
      pathKind: "file",
    });

    expect(operations(outcome)).toMatchObject([{ target: SHARED_PATH, type: "symlink" }]);
  });

  it("refuses an entry carrying the user's own text beside the block", () => {
    const outcome = plan({
      content:
        "# Mine\n\nKeep this.\n<!-- aura:begin -->\n@~/agents/AGENTS.md\n<!-- aura:end -->\n",
      pathKind: "file",
    });

    expect(outcome).toEqual({
      blocked:
        "The existing file is user-owned. Consolidate its content before replacing it with a symlink.",
    });
  });

  it("still plans the write when a matching native copy is being replaced", () => {
    const link: ResolvedSharedLink = {
      content: "# shared\n",
      entryPath: ENTRY_PATH,
      kind: "native-copy",
      scope: "global",
    };
    // The copy on disk already holds exactly what the link declares.
    const copied: InstructionDocument = {
      content: "# shared\n",
      links: [],
      path: ENTRY_PATH,
      scope: "global",
      sourceId: "instructions",
    };
    const application: AppModel = {
      ...app(link, { exists: true, pathKind: "file" }),
      instructionFiles: [copied],
    };
    const model = workspace(application);

    const converged = planSharedInstructionLink(application, model, { link });
    const replacing = planSharedInstructionLink(application, model, { link, sourceContent: "" });

    expect(operations(converged)).toEqual([]);
    expect(operations(replacing)).toMatchObject([{ path: ENTRY_PATH, type: "write" }]);
  });
});

function plan(
  source: {
    readonly pathKind: AdapterPathKind;
    readonly symlinkTarget?: string | undefined;
    readonly content?: string | undefined;
  },
  options: { readonly sourceContent?: string } = {},
) {
  const link: ResolvedSharedLink = { entryPath: ENTRY_PATH, kind: "symlink", scope: "global" };
  const application = app(link, { exists: true, ...source });
  return planSharedInstructionLink(application, workspace(application), { link, ...options });
}

function operations(outcome: ReturnType<typeof planSharedInstructionLink>) {
  if ("blocked" in outcome) {
    throw new Error(`Expected a plan, got: ${outcome.blocked}`);
  }
  return outcome.plan.operations;
}

function app(
  link: ResolvedSharedLink,
  source: {
    readonly exists: boolean;
    readonly pathKind?: AdapterPathKind | undefined;
    readonly symlinkTarget?: string | undefined;
    readonly content?: string | undefined;
  },
): AppModel {
  return {
    adapterId: "codex",
    detection: { installed: true, version: "1.0.0" },
    displayName: "Codex",
    instructionFiles:
      source.content === undefined
        ? []
        : [
            {
              content: source.content,
              links: [],
              path: link.entryPath,
              scope: "global",
              sourceId: "codex.instructions",
            },
          ],
    mcpServers: [],
    sharedLink: link,
    skills: [],
    sourceFiles: [
      {
        exists: source.exists,
        ...(source.pathKind === undefined ? {} : { pathKind: source.pathKind }),
        spec: {
          id: "codex.instructions",
          kind: "instructions",
          path: link.entryPath,
          scope: "global",
        },
        ...(source.symlinkTarget === undefined ? {} : { symlinkTarget: source.symlinkTarget }),
      },
    ],
    support: { status: "supported", supportedRange: ">=1 <2", version: "1.0.0" },
  };
}

function workspace(application: AppModel): WorkspaceModel {
  return createWorkspaceModel({
    apps: [application],
    manifest: { exists: false, path: "/home/dev/agents/aura.json", status: "missing" },
    sharedInstructions: { content: "# shared\n", exists: true, path: SHARED_PATH },
  });
}
