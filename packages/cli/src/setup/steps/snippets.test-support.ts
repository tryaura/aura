import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { AuraManifestState, RepoSnippetEntry, Snippet } from "@tryaura/aura-sdk";
import { createWorkspaceModel } from "@tryaura/aura-sdk/testing";

import { createSnippetCatalog } from "../snippets.js";
import { createTemporaryRoot, emptyMcpCatalog, emptySkillCatalog } from "../testing.js";
import type { SetupStepContext } from "../types.js";
import { createScriptedWizardIo } from "../wizard-scripted.js";
import type { WizardOption, WizardQuestion } from "../wizard-types.js";
import { snippetsStep } from "./snippets.js";

export async function askedOptions(
  stepContext: SetupStepContext,
): Promise<readonly WizardOption[]> {
  const scripted = createScriptedWizardIo();
  const asked: WizardQuestion[] = [];

  await snippetsStep.gather(stepContext, {
    ask: async (questions) => {
      asked.push(...questions);
      return scripted.ask(questions);
    },
    confirm: scripted.confirm,
    load: scripted.load,
    note: scripted.note,
  });

  const question = asked[0];
  if (question === undefined) {
    throw new Error("no question was asked");
  }
  return question.options;
}

export async function createRoot(): Promise<string> {
  return createTemporaryRoot("aura-snippet-step-");
}

export async function file(
  root: string,
  id: string,
  category: string,
  content = `Body of ${id}.\n`,
  version = "1.0.0",
): Promise<Snippet> {
  const path = join(root, `${id.replace("/", "-")}.md`);
  await writeFile(path, content, "utf8");
  return {
    category,
    description: `Description for ${id}.`,
    id,
    kind: "snippet",
    name: id,
    source: { type: "file", url: pathToFileURL(path).href },
    version,
  };
}

export async function askedNotes(stepContext: SetupStepContext): Promise<readonly string[]> {
  const scripted = createScriptedWizardIo();
  await snippetsStep.gather(stepContext, scripted);
  return scripted.notes;
}

/** Repository-defined snippets and the ids the repo preset labels as its selections. */
export interface RepoFixture {
  readonly selected?: readonly string[] | undefined;
  readonly snippets: readonly RepoSnippetEntry[];
}

export function context(
  snippets: readonly Snippet[],
  manifest: AuraManifestState,
  presetSnippets: readonly string[] = [],
  sharedContent?: string,
  repo?: RepoFixture,
): SetupStepContext {
  return {
    appCatalog: [],
    findings: [],
    interactive: false,
    isEnvironmentVariableSet: () => false,
    manifest,
    mcpCatalog: emptyMcpCatalog(),
    model: createWorkspaceModel({
      manifest,
      sharedInstructions: {
        exists: sharedContent !== undefined,
        path: "/home/dev/agents/AGENTS.md",
        ...(sharedContent === undefined ? {} : { content: sharedContent }),
      },
    }),
    ...(presetSnippets.length === 0
      ? {}
      : {
          preset: {
            checkSummary: [],
            explicit: true,
            name: "Fixture preset",
            reference: "plugin:fixture/onboarding",
            skills: [],
            snippets: presetSnippets,
          },
        }),
    ...(repo === undefined
      ? {}
      : {
          repoPreset: {
            accepted: true,
            checkSummary: [],
            contentSet: { mcpServers: [], skills: [], snippets: repo.snippets },
            hash: "f".repeat(64),
            path: "/workspace/.aura/preset.json",
            preset: {
              schemaVersion: 1 as const,
              ...(repo.selected === undefined ? {} : { snippets: repo.selected }),
            },
            recorded: true,
            status: "applied" as const,
          },
        }),
    selections: {},
    skillCatalog: emptySkillCatalog(),
    snippetCatalog: createSnippetCatalog(
      snippets,
      manifest,
      [...presetSnippets, ...(repo?.selected ?? [])],
      repo?.snippets ?? [],
    ),
  };
}

export function missingManifest(): AuraManifestState {
  return { exists: false, path: "/home/dev/agents/aura.json", status: "missing" };
}

export function readyManifest(id: string, hash?: string): AuraManifestState {
  return recordedManifest([{ ...(hash === undefined ? {} : { hash }), id }]);
}

/** Several recorded ids, none of them hashed — the shape a multi-row record block needs. */
export function readyManifestIds(...ids: readonly string[]): AuraManifestState {
  return recordedManifest(ids.map((id) => ({ id })));
}

function recordedManifest(
  snippets: readonly { readonly hash?: string; readonly id: string }[],
): AuraManifestState {
  return {
    exists: true,
    path: "/home/dev/agents/aura.json",
    status: "ready",
    value: { apps: {}, mcpServers: [], ownership: {}, schemaVersion: 1, skills: [], snippets },
  };
}
