import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { AuraManifestState, Snippet } from "@tryaura/aura-sdk";
import { createWorkspaceModel } from "@tryaura/aura-sdk/testing";
import { hashManagedSnippet, reconcileManagedBlock } from "@tryaura/core";

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

export function context(
  snippets: readonly Snippet[],
  manifest: AuraManifestState,
  presetSnippets: readonly string[] = [],
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
      sharedInstructions: { exists: false, path: "/home/dev/agents/AGENTS.md" },
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
    selections: {},
    skillCatalog: emptySkillCatalog(),
    snippetCatalog: createSnippetCatalog(snippets, manifest, presetSnippets),
  };
}

export function updateContext(snippet: Snippet, installedContent: string): SetupStepContext {
  const id = snippet.id;
  const manifest: AuraManifestState = {
    exists: true,
    path: "/home/dev/agents/aura.json",
    status: "ready",
    value: {
      apps: {},
      mcpServers: [],
      ownership: {},
      schemaVersion: 1,
      skills: [],
      snippets: [
        {
          hash: hashManagedSnippet(installedContent),
          id,
          pinned: false,
          version: "1.0.0",
        },
      ],
    },
  };
  const base = context([snippet], manifest);
  return {
    ...base,
    model: createWorkspaceModel({
      manifest,
      sharedInstructions: {
        content: reconcileManagedBlock("", [{ content: installedContent, id }]).content,
        exists: true,
        path: "/home/dev/agents/AGENTS.md",
      },
    }),
  };
}

export function missingManifest(): AuraManifestState {
  return { exists: false, path: "/home/dev/agents/aura.json", status: "missing" };
}

export function readyManifest(id: string): AuraManifestState {
  return {
    exists: true,
    path: "/home/dev/agents/aura.json",
    status: "ready",
    value: {
      apps: {},
      mcpServers: [],
      ownership: {},
      schemaVersion: 1,
      skills: [],
      snippets: [{ hash: "a".repeat(64), id, pinned: false, version: "1.2.3" }],
    },
  };
}
