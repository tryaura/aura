import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  defineCheck,
  type Check,
  type Environment,
  type Finding,
  type FixPlan,
  type WorkspaceModel,
} from "@tryaura/aura-sdk";
import { createWorkspaceModel } from "@tryaura/aura-sdk/testing";

import type { FixRequest } from "../fix.js";
import type {
  WizardAnswers,
  WizardConfirmation,
  WizardFormResult,
  WizardIo,
  WizardQuestion,
} from "../setup/wizard-types.js";
import { BRANDING } from "../testing.js";

const FIXTURE_ROOT = fileURLToPath(new URL("..", import.meta.url));

interface GuidedOptions {
  readonly fix?: (() => FixPlan | undefined) | undefined;
  readonly guidedFixes?: NonNullable<Extract<Check, { fixability: "guided" }>["guidedFixes"]>;
}

export function guidedCheck(options: GuidedOptions): Check {
  return defineCheck({
    defaultSeverity: "warn",
    detect: () => [],
    explain:
      "The rule keeps agent behavior predictable.\n\nInspect the setting and choose a resolution.",
    fix: options.fix ?? (() => undefined),
    fixability: "guided",
    guidedFixes: options.guidedFixes,
    id: "fixture/GUIDED",
    scope: "global",
    title: "Guided check",
  });
}

export function automaticCheck(plan = writePlan("automatic.md", "automatic")): Check {
  return defineCheck({
    defaultSeverity: "warn",
    detect: () => [],
    explain: "The rule keeps agent behavior predictable.\n\nRun the automatic fix.",
    fix: () => plan,
    fixability: "auto",
    id: "fixture/AUTO",
    scope: "global",
    title: "Automatic check",
  });
}

export function finding(check: Check, id: string): Finding {
  return {
    checkId: check.id,
    id,
    message: `${id} finding`,
    scope: check.scope,
    severity: check.defaultSeverity,
  };
}

export function writePlan(name: string, content: string): FixPlan {
  return writePlanAt(FIXTURE_ROOT, name, content);
}

export function writePlanAt(root: string, name: string, content: string): FixPlan {
  return {
    operations: [{ content, path: join(root, name), type: "write" }],
    summary: `Write ${name}.`,
  };
}

export function model(root = FIXTURE_ROOT): WorkspaceModel {
  return createWorkspaceModel({
    cwd: root,
    homeDir: root,
    manifest: { exists: false, path: join(root, "agents", "aura.json"), status: "missing" },
    projectRoot: root,
    sharedInstructions: { exists: false, path: join(root, "agents", "AGENTS.md") },
  });
}

export function environment(
  root = FIXTURE_ROOT,
  now: Environment["now"] = missingClock,
): Environment {
  return {
    cwd: root,
    exec: () => Promise.resolve({ exitCode: 0, stderr: "", stdout: "" }),
    homeDir: root,
    httpGet: () => Promise.resolve({ kind: "failure", reason: "network" }),
    now,
    pathEntries: [],
    platform: "darwin",
    readVariable: () => undefined,
  };
}

export function request(overrides: Partial<FixRequest> = {}): FixRequest {
  return {
    branding: BRANDING,
    checks: [],
    colorDepth: 0,
    dryRun: false,
    environment: environment(),
    findings: [],
    interactive: false,
    model: model(),
    stateHomeDir: FIXTURE_ROOT,
    stderr: new TextOutput(),
    stdin: Readable.from([]),
    stdout: new TextOutput(),
    withDetail: false,
    yes: false,
    ...overrides,
  };
}

const missingClock: Environment["now"] = () => {
  throw new Error("This fixture requires an injected clock before applying a plan.");
};

export interface ScriptedWizard extends WizardIo {
  readonly confirmations: number;
  readonly questions: readonly (readonly WizardQuestion[])[];
}

export function scriptedWizard(
  answers: readonly WizardFormResult[],
  confirmation: WizardConfirmation = "declined",
): ScriptedWizard {
  const queue = [...answers];
  const questions: (readonly WizardQuestion[])[] = [];
  let confirmations = 0;
  return {
    ask: (asked) => {
      questions.push(asked);
      return Promise.resolve(queue.shift() ?? "aborted");
    },
    confirm: () => {
      confirmations += 1;
      return Promise.resolve(confirmation);
    },
    get confirmations() {
      return confirmations;
    },
    note: () => {},
    questions,
  };
}

export function answer(id: string, value: string): WizardAnswers {
  return { [id]: { kind: "options", values: [value] } };
}

export class TextOutput extends Writable {
  text = "";

  constructor(private readonly observe: (chunk: string) => void = () => {}) {
    super();
  }

  // fallow-ignore-next-line unused-class-member -- Writable invokes this stream hook.
  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    this.observe(text);
    this.text += text;
    callback();
  }
}
