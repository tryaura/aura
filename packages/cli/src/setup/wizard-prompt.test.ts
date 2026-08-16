import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { createInteractiveWizardIo } from "./wizard-prompt.js";
import type { WizardQuestion } from "./wizard-types.js";

const APPS_QUESTION: WizardQuestion = {
  freeText: true,
  id: "apps",
  initial: ["both"],
  kind: "select",
  label: "Apps",
  options: [
    { label: "Claude Code + Cursor", value: "both" },
    { label: "Claude Code only", value: "claude" },
  ],
  prompt: "Which apps should Aura manage?",
};

const MCP_QUESTION: WizardQuestion = {
  id: "mcp",
  initial: ["linear"],
  kind: "multiselect",
  label: "MCP",
  options: [
    { label: "linear", value: "linear" },
    { label: "context7", value: "context7" },
  ],
  prompt: "Which MCP servers should every managed app get?",
};

interface Session {
  readonly output: () => string;
  readonly press: (name: string, extras?: { ctrl?: boolean; sequence?: string }) => void;
  readonly rawModeCalls: readonly boolean[];
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly type: (text: string) => void;
}

function createSession(): Session {
  const rawModeCalls: boolean[] = [];
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: (mode: boolean): void => {
      rawModeCalls.push(mode);
    },
  });
  const stdout = new PassThrough();
  stdout.setEncoding("utf8");
  const chunks: string[] = [];
  stdout.on("data", (chunk: string) => {
    chunks.push(chunk);
  });

  return {
    output: () => chunks.join(""),
    press: (name, extras = {}) => {
      stdin.emit("keypress", extras.sequence, {
        ctrl: extras.ctrl ?? false,
        meta: false,
        name,
        sequence: extras.sequence,
        shift: false,
      });
    },
    rawModeCalls,
    stdin,
    stdout,
    type: (text) => {
      for (const character of text) {
        stdin.emit("keypress", character, {
          ctrl: false,
          meta: false,
          name: undefined,
          sequence: character,
          shift: false,
        });
      }
    },
  };
}

describe("interactive wizard", () => {
  it("answers a select question with enter and submits", async () => {
    const session = createSession();
    const io = createInteractiveWizardIo({
      colorDepth: 0,
      stdin: session.stdin,
      stdout: session.stdout,
    });

    const form = io.ask([APPS_QUESTION]);
    session.press("down");
    session.press("return");
    session.press("return");

    await expect(form).resolves.toEqual({ apps: { kind: "options", values: ["claude"] } });
    expect(session.output()).toContain("☑ Apps  Claude Code only");
  });

  it("toggles multiselect values with space before answering", async () => {
    const session = createSession();
    const io = createInteractiveWizardIo({
      colorDepth: 0,
      stdin: session.stdin,
      stdout: session.stdout,
    });

    const form = io.ask([MCP_QUESTION]);
    session.press("down");
    session.press("space", { sequence: " " });
    session.press("return");
    session.press("return");

    await expect(form).resolves.toEqual({
      mcp: { kind: "options", values: ["linear", "context7"] },
    });
  });

  it("collects free text typed on the trailing row", async () => {
    const session = createSession();
    const io = createInteractiveWizardIo({
      colorDepth: 0,
      stdin: session.stdin,
      stdout: session.stdout,
    });

    const form = io.ask([APPS_QUESTION]);
    session.press("down");
    session.press("down");
    session.type("codexx");
    session.press("backspace");
    session.press("return");
    session.press("return");

    await expect(form).resolves.toEqual({ apps: { kind: "text", text: "codex" } });
  });

  it("moves between question tabs and back", async () => {
    const session = createSession();
    const io = createInteractiveWizardIo({
      colorDepth: 0,
      stdin: session.stdin,
      stdout: session.stdout,
    });

    const form = io.ask([APPS_QUESTION, MCP_QUESTION]);
    session.press("right");
    session.press("left");
    session.press("return");
    session.press("return");
    session.press("return");

    await expect(form).resolves.toEqual({
      apps: { kind: "options", values: ["both"] },
      mcp: { kind: "options", values: ["linear"] },
    });
  });

  it("jumps to the first unanswered question when submitting early", async () => {
    const session = createSession();
    const io = createInteractiveWizardIo({
      colorDepth: 0,
      stdin: session.stdin,
      stdout: session.stdout,
    });

    const form = io.ask([APPS_QUESTION, MCP_QUESTION]);
    session.press("right");
    session.press("right");
    session.press("return");
    session.press("return");
    session.press("return");
    session.press("return");

    await expect(form).resolves.toEqual({
      apps: { kind: "options", values: ["both"] },
      mcp: { kind: "options", values: ["linear"] },
    });
  });

  it("aborts on ctrl+c and restores the terminal", async () => {
    const session = createSession();
    const io = createInteractiveWizardIo({
      colorDepth: 0,
      stdin: session.stdin,
      stdout: session.stdout,
    });

    const form = io.ask([APPS_QUESTION]);
    session.press("c", { ctrl: true });

    await expect(form).resolves.toBe("aborted");
    expect(session.rawModeCalls).toEqual([true, false]);
    expect(session.stdin.listenerCount("keypress")).toBe(0);
  });

  it("aborts when stdin ends mid-form", async () => {
    const session = createSession();
    const io = createInteractiveWizardIo({
      colorDepth: 0,
      stdin: session.stdin,
      stdout: session.stdout,
    });

    const form = io.ask([APPS_QUESTION]);
    session.stdin.end();

    await expect(form).resolves.toBe("aborted");
  });

  it("maps the confirm form onto accept and decline", async () => {
    const accept = createSession();
    const acceptIo = createInteractiveWizardIo({
      colorDepth: 0,
      stdin: accept.stdin,
      stdout: accept.stdout,
    });
    const accepted = acceptIo.confirm("Apply this plan?");
    accept.press("return");
    await expect(accepted).resolves.toBe("accepted");

    const decline = createSession();
    const declineIo = createInteractiveWizardIo({
      colorDepth: 0,
      stdin: decline.stdin,
      stdout: decline.stdout,
    });
    const declined = declineIo.confirm("Apply this plan?");
    decline.press("down");
    decline.press("return");
    await expect(declined).resolves.toBe("declined");
  });

  it("previews a row without changing its selection", async () => {
    const session = createSession();
    const io = createInteractiveWizardIo({
      colorDepth: 0,
      stdin: session.stdin,
      stdout: session.stdout,
    });
    const question: WizardQuestion = {
      id: "snippets",
      kind: "multiselect",
      label: "Snippets",
      options: [{ label: "Rules", preview: "# Full rules", value: "official/rules" }],
      prompt: "Choose snippets",
    };

    const form = io.ask([question]);
    session.press("p", { sequence: "p" });
    expect(session.output()).toContain("# Full rules");
    session.press("escape");
    session.press("space", { sequence: " " });
    session.press("return");

    await expect(form).resolves.toEqual({
      snippets: { kind: "options", values: ["official/rules"] },
    });
  });

  it("lets a disabled initial selection be cleared but never re-selected", async () => {
    const session = createSession();
    const io = createInteractiveWizardIo({
      colorDepth: 0,
      stdin: session.stdin,
      stdout: session.stdout,
    });
    const form = io.ask([
      {
        id: "snippets",
        initial: ["retired/rules"],
        kind: "multiselect",
        label: "Snippets",
        options: [{ disabled: true, label: "Retired", value: "retired/rules" }],
        prompt: "Choose snippets",
      },
    ]);

    // The first space gives the stale selection up; the second must not take it back.
    session.press("space", { sequence: " " });
    session.press("space", { sequence: " " });
    session.press("return");

    await expect(form).resolves.toEqual({
      snippets: { kind: "options", values: [] },
    });
  });
});
