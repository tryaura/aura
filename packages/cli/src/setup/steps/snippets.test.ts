import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { AuraManifestState, Snippet } from "@tryaura/aura-sdk";
import { createWorkspaceModel } from "@tryaura/aura-sdk/testing";

import { createSnippetCatalog } from "../snippets.js";
import { emptyMcpCatalog, emptySkillCatalog } from "../testing.js";
import type { SetupStepContext } from "../types.js";
import { createScriptedWizardIo } from "../wizard-scripted.js";
import type { WizardAnswers, WizardOption, WizardQuestion } from "../wizard-types.js";
import { snippetsStep } from "./snippets.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("snippets step", () => {
  it("orders the picker by category so each heading covers one run of rows", async () => {
    const root = await createRoot();
    const registry = [
      await file(root, "official/zulu", "safety"),
      await file(root, "official/alpha", "workflow"),
      await file(root, "official/bravo", "safety"),
    ];

    const options = await askedOptions(context(registry, missingManifest()));

    expect(options.map((option) => [option.group, option.value])).toEqual([
      ["safety", "official/bravo"],
      ["safety", "official/zulu"],
      ["workflow", "official/alpha"],
    ]);
  });

  it("keeps a cleared unavailable selection cleared", async () => {
    const stepContext = context([], readyManifest("retired/rules"));

    const outcome = await snippetsStep.gather(
      stepContext,
      createScriptedWizardIo({ forms: [{ snippets: { kind: "options", values: [] } }] }),
    );

    expect(outcome).toEqual({ snippets: { selected: [] } });
  });

  it("carries an unavailable selection the user left alone", async () => {
    const stepContext = context([], readyManifest("retired/rules"));
    const answered: WizardAnswers = {
      snippets: { kind: "options", values: ["retired/rules"] },
    };

    const outcome = await snippetsStep.gather(
      stepContext,
      createScriptedWizardIo({ forms: [answered] }),
    );

    expect(outcome).toEqual({ snippets: { selected: ["retired/rules"] } });
  });
});

async function askedOptions(stepContext: SetupStepContext): Promise<readonly WizardOption[]> {
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

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aura-snippet-step-"));
  temporaryDirectories.push(root);
  return root;
}

async function file(root: string, id: string, category: string): Promise<Snippet> {
  const path = join(root, `${id.replace("/", "-")}.md`);
  await writeFile(path, `Body of ${id}.\n`, "utf8");
  return {
    category,
    description: `Description for ${id}.`,
    id,
    kind: "snippet",
    name: id,
    source: { type: "file", url: pathToFileURL(path).href },
    version: "1.0.0",
  };
}

function context(snippets: readonly Snippet[], manifest: AuraManifestState): SetupStepContext {
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
    selections: {},
    skillCatalog: emptySkillCatalog(),
    snippetCatalog: createSnippetCatalog(snippets, manifest),
  };
}

function missingManifest(): AuraManifestState {
  return { exists: false, path: "/home/dev/agents/aura.json", status: "missing" };
}

function readyManifest(id: string): AuraManifestState {
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
