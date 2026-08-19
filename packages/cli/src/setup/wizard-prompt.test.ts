/* eslint-disable max-lines -- one keypress-driven matrix shares the same terminal fixtures. */
import process from "node:process";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { displayWidth } from "../text-width.js";
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
  initial: ["acme"],
  kind: "multiselect",
  label: "MCP",
  options: [
    { label: "acme", value: "acme" },
    { label: "context7", value: "context7" },
  ],
  prompt: "Which MCP servers should every managed app get?",
};

interface Session {
  readonly output: () => string;
  readonly press: (
    name: string,
    extras?: { ctrl?: boolean; sequence?: string; shift?: boolean },
  ) => void;
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
        shift: extras.shift ?? false,
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

/** Everything painted since the last erase: the frame currently on screen. */
function lastFrame(session: Session): string {
  const output = session.output();
  return output.slice(output.lastIndexOf("\u001b[0J"));
}

describe("interactive wizard", () => {
  it("keeps the flow header and per-item loader visible during asynchronous work", async () => {
    const session = createSession();
    const io = createInteractiveWizardIo({
      colorDepth: 0,
      stdin: session.stdin,
      stdout: session.stdout,
    });
    const gate = Promise.withResolvers<void>();
    const statuses: string[] = [];

    const loading = io.load(
      {
        items: [
          { id: "agenticskills", label: "AgenticSkills" },
          { id: "team", label: "Team skills" },
        ],
        prompt: "Loading skill sources…",
      },
      async (update) => {
        update("agenticskills", "active");
        statuses.push("active");
        await gate.promise;
        update("agenticskills", "complete");
        statuses.push("complete");
        return 42;
      },
      {
        completed: [{ label: "Snippets" }],
        step: { label: "Skills" },
        upcoming: [{ label: "MCP" }],
      },
    );

    expect(session.output()).toContain("✔ Snippets │ ▶ Skills ☐ │ MCP ☐ │ Submit");
    expect(session.output()).toContain("AgenticSkills");
    expect(session.output()).toContain("Team skills");
    gate.resolve();

    await expect(loading).resolves.toBe(42);
    expect(statuses).toEqual(["active", "complete"]);
  });

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
    expect(session.output()).toContain("✔ Apps  Claude Code only");
  });

  it("marks a select option with space without answering or advancing", async () => {
    const session = createSession();
    const io = createInteractiveWizardIo({
      colorDepth: 0,
      stdin: session.stdin,
      stdout: session.stdout,
    });

    const form = io.ask([APPS_QUESTION, MCP_QUESTION]);
    session.press("down");
    session.press("space", { sequence: " " });

    // The mark moved off the seeded option, but the step stays open on its own tab.
    const marked = lastFrame(session);
    expect(marked).toContain("▶ Apps ☐");
    expect(marked).toContain("1. ○ Claude Code + Cursor");
    expect(marked).toContain("❯ 2. ● Claude Code only");

    session.press("return");
    session.press("return");
    session.press("return");

    await expect(form).resolves.toEqual({
      apps: { kind: "options", values: ["claude"] },
      mcp: { kind: "options", values: ["acme"] },
    });
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
      mcp: { kind: "options", values: ["acme", "context7"] },
    });
  });

  it("shows a small first page and every matching row while searching", async () => {
    const session = createSession();
    const io = createInteractiveWizardIo({
      colorDepth: 0,
      stdin: session.stdin,
      stdout: session.stdout,
    });
    const options = Array.from({ length: 12 }, (_, index) => ({
      label: `Match ${String(index + 1)}`,
      value: `match-${String(index + 1)}`,
    }));
    const form = io.ask([
      {
        id: "skills",
        kind: "multiselect",
        label: "Skills",
        options,
        prompt: "Choose skills",
        search: { initialLimit: 10, placeholder: "Search all 12 skills" },
      },
    ]);

    expect(session.output()).toContain("10. ☐ Match 10");
    expect(session.output()).not.toContain("11. ☐ Match 11");
    expect(session.output()).toContain("/ Search all 12 skills");

    session.press("/", { sequence: "/" });
    session.type("match");
    session.press("return");
    expect(session.output()).toContain("/ Search: match · 12 matches");
    expect(session.output()).toContain("12. ☐ Match 12");

    for (let index = 0; index < 10; index += 1) {
      session.press("down");
    }
    session.press("space", { sequence: " " });
    session.press("return");

    await expect(form).resolves.toEqual({
      skills: { kind: "options", values: ["match-11"] },
    });
  });

  it("keeps an initial selection visible beyond a searchable question's first page", async () => {
    const session = createSession();
    const io = createInteractiveWizardIo({
      colorDepth: 0,
      stdin: session.stdin,
      stdout: session.stdout,
    });
    const options = Array.from({ length: 12 }, (_, index) => ({
      label: `Skill ${String(index + 1)}`,
      value: `skill-${String(index + 1)}`,
    }));
    const form = io.ask([
      {
        id: "skills",
        initial: ["skill-12"],
        kind: "multiselect",
        label: "Skills",
        options,
        prompt: "Choose skills",
        search: { initialLimit: 10, placeholder: "Search all 12 skills" },
      },
    ]);

    expect(session.output()).toContain("11. ☑ Skill 12");
    session.press("return");

    await expect(form).resolves.toEqual({
      skills: { kind: "options", values: ["skill-12"] },
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

  it("moves focus backward on shift-tab", async () => {
    const session = createSession();
    const io = createInteractiveWizardIo({
      colorDepth: 0,
      stdin: session.stdin,
      stdout: session.stdout,
    });

    const form = io.ask([APPS_QUESTION, MCP_QUESTION]);
    session.press("tab");
    expect(session.output()).toContain("Which MCP servers");
    session.press("tab", { shift: true });
    // Focus is back on the first question; answering both and submitting resolves the form.
    session.press("return");
    session.press("return");
    session.press("return");

    await expect(form).resolves.toEqual({
      apps: { kind: "options", values: ["both"] },
      mcp: { kind: "options", values: ["acme"] },
    });
  });

  it("removes a whole emoji on backspace instead of splitting the surrogate pair", async () => {
    const session = createSession();
    const io = createInteractiveWizardIo({
      colorDepth: 0,
      stdin: session.stdin,
      stdout: session.stdout,
    });

    const form = io.ask([APPS_QUESTION]);
    session.press("down");
    session.press("down");
    session.type("a😀");
    session.press("backspace");
    session.press("return");
    session.press("return");

    await expect(form).resolves.toEqual({ apps: { kind: "text", text: "a" } });
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
      mcp: { kind: "options", values: ["acme"] },
    });
  });

  it("keeps ↵ inert on Submit until every step is answered", async () => {
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
    expect(session.output()).toContain("Submit unlocks once every step below is answered.");

    session.press("left");
    session.press("left");
    session.press("return");
    session.press("return");
    session.press("return");

    await expect(form).resolves.toEqual({
      apps: { kind: "options", values: ["both"] },
      mcp: { kind: "options", values: ["acme"] },
    });
  });

  it("shows the surrounding flow and submits a flow form on its last answer", async () => {
    const session = createSession();
    const io = createInteractiveWizardIo({
      colorDepth: 0,
      stdin: session.stdin,
      stdout: session.stdout,
    });

    const form = io.ask([APPS_QUESTION, MCP_QUESTION], {
      completed: [{ label: "Baseline" }],
      upcoming: [{ label: "Snippets" }],
    });
    expect(session.output()).toContain(" ✔ Baseline │ ▶ Apps ☐ │ MCP ☐ │ Snippets ☐ │ Submit");

    // No review tab of its own: answering the second question resolves the form.
    session.press("return");
    session.press("return");

    await expect(form).resolves.toEqual({
      apps: { kind: "options", values: ["both"] },
      mcp: { kind: "options", values: ["acme"] },
    });
  });

  it("renders a static step row with a └ sub-row for a chain form", async () => {
    const session = createSession();
    const io = createInteractiveWizardIo({
      colorDepth: 0,
      stdin: session.stdin,
      stdout: session.stdout,
    });

    const form = io.ask([MCP_QUESTION], {
      completed: [{ label: "Applications" }],
      step: { label: "Instructions" },
      sub: { completed: [{ label: "Global" }], upcoming: [] },
      upcoming: [{ label: "Baseline" }],
    });
    expect(session.output()).toContain(
      " ✔ Applications │ ▶ Instructions ☐ │ Baseline ☐ │ Submit\n └ ✔ Global │ ▶ MCP ☐",
    );
    session.press("return");

    await expect(form).resolves.toEqual({ mcp: { kind: "options", values: ["acme"] } });
  });

  it("honors ← when only the step's own chain has history", async () => {
    const session = createSession();
    const io = createInteractiveWizardIo({
      colorDepth: 0,
      stdin: session.stdin,
      stdout: session.stdout,
    });

    const form = io.ask([MCP_QUESTION], {
      completed: [],
      step: { label: "Instructions" },
      sub: { completed: [{ label: "Global" }], upcoming: [] },
      upcoming: [],
    });
    session.press("left");

    await expect(form).resolves.toBe("back");
  });

  it("resolves back when ← leaves the first tab of a flow form with history", async () => {
    const session = createSession();
    const io = createInteractiveWizardIo({
      colorDepth: 0,
      stdin: session.stdin,
      stdout: session.stdout,
    });

    const form = io.ask([MCP_QUESTION], {
      completed: [{ label: "Applications" }],
      upcoming: [],
    });
    session.press("left");

    await expect(form).resolves.toBe("back");
    // A backed-out form leaves no collapsed summary behind.
    expect(session.output()).not.toContain("✔ MCP");
  });

  it("keeps ← a no-op on the first tab when nothing precedes the form", async () => {
    const session = createSession();
    const io = createInteractiveWizardIo({
      colorDepth: 0,
      stdin: session.stdin,
      stdout: session.stdout,
    });

    const form = io.ask([MCP_QUESTION], { completed: [], upcoming: [{ label: "Baseline" }] });
    session.press("left");
    session.press("return");

    await expect(form).resolves.toEqual({ mcp: { kind: "options", values: ["acme"] } });
  });

  it("commits a flow form and advances when → leaves its last tab", async () => {
    const session = createSession();
    const io = createInteractiveWizardIo({
      colorDepth: 0,
      stdin: session.stdin,
      stdout: session.stdout,
    });

    const form = io.ask([MCP_QUESTION], {
      completed: [{ label: "Applications" }],
      upcoming: [{ label: "Baseline" }],
    });
    session.press("right");

    await expect(form).resolves.toEqual({ mcp: { kind: "options", values: ["acme"] } });
  });

  it("→ commits a re-seeded select answer without re-answering it", async () => {
    const session = createSession();
    const io = createInteractiveWizardIo({
      colorDepth: 0,
      stdin: session.stdin,
      stdout: session.stdout,
    });

    // The remembered answer is the second option; the cursor must not re-answer with the first.
    const form = io.ask(
      [
        {
          id: "mode",
          initial: ["second"],
          kind: "select",
          label: "Mode",
          options: [
            { label: "First option", value: "first" },
            { label: "Second option", value: "second" },
          ],
          prompt: "Which mode should Aura use?",
        },
      ],
      { completed: [{ label: "Global" }], upcoming: [{ label: "Snippets" }] },
    );
    session.press("right");

    await expect(form).resolves.toEqual({ mode: { kind: "options", values: ["second"] } });
  });

  it("keeps → inert on the flow's last form", async () => {
    const session = createSession();
    const io = createInteractiveWizardIo({
      colorDepth: 0,
      stdin: session.stdin,
      stdout: session.stdout,
    });

    const form = io.ask([MCP_QUESTION], {
      completed: [{ label: "Applications" }],
      step: { label: "Baseline" },
      upcoming: [],
    });
    session.press("right");
    session.press("right");
    // Nothing ahead but Submit, so → left the form standing; only ↵ resolves it.
    session.press("return");

    await expect(form).resolves.toEqual({ mcp: { kind: "options", values: ["acme"] } });
  });

  it("opens a select with the cursor on its current answer", async () => {
    const session = createSession();
    const io = createInteractiveWizardIo({
      colorDepth: 0,
      stdin: session.stdin,
      stdout: session.stdout,
    });

    const form = io.ask([
      {
        id: "pick",
        initial: ["second"],
        kind: "select",
        label: "Pick",
        options: [
          { label: "First", value: "first" },
          { label: "Second", value: "second" },
        ],
        prompt: "Pick one",
      },
    ]);
    expect(session.output()).toContain("❯ 2. ● Second");
    session.press("return");

    await expect(form).resolves.toEqual({ pick: { kind: "options", values: ["second"] } });
  });

  it("keeps → away from the Submit form's answer", async () => {
    const session = createSession();
    const io = createInteractiveWizardIo({
      colorDepth: 0,
      stdin: session.stdin,
      stdout: session.stdout,
    });

    const confirmation = io.confirm("Apply this plan?", {
      completed: [{ label: "Applications" }],
      submit: true,
      upcoming: [],
    });
    session.press("right");
    session.press("down");
    session.press("return");

    // → must never apply a plan; only ↵ resolves the confirmation, here on Cancel.
    await expect(confirmation).resolves.toBe("declined");
  });

  it("prints a form's collapsed summary only on its first completion", async () => {
    const session = createSession();
    const io = createInteractiveWizardIo({
      colorDepth: 0,
      stdin: session.stdin,
      stdout: session.stdout,
    });
    const flow = { completed: [{ label: "Baseline" }], upcoming: [] };

    const first = io.ask([MCP_QUESTION], flow);
    session.press("return");
    await first;
    const second = io.ask([MCP_QUESTION], flow);
    session.press("return");
    await second;

    const summaries = session
      .output()
      .split("\n")
      .filter((line) => line.includes("✔ MCP"));
    expect(summaries).toHaveLength(1);
  });

  it("reprints the collapsed summary when a re-answer changed it", async () => {
    const session = createSession();
    const io = createInteractiveWizardIo({
      colorDepth: 0,
      stdin: session.stdin,
      stdout: session.stdout,
    });
    const flow = { completed: [{ label: "Baseline" }], upcoming: [] };

    const first = io.ask([MCP_QUESTION], flow);
    session.press("return");
    await first;
    const second = io.ask([MCP_QUESTION], flow);
    session.press("down");
    session.press("space", { sequence: " " });
    session.press("return");
    await second;

    // The stale "acme" line must not be the scrollback's last word about this step.
    const summaries = session
      .output()
      .split("\n")
      .filter((line) => line.includes("✔ MCP"));
    expect(summaries).toHaveLength(2);
    expect(summaries[1]).toContain("acme, context7");
  });

  it("repaints against the new viewport when the terminal resizes", async () => {
    const session = createSession();
    const io = createInteractiveWizardIo({
      colorDepth: 0,
      stdin: session.stdin,
      stdout: session.stdout,
    });

    const form = io.ask([MCP_QUESTION]);
    const framesBefore = session.output().split("Which MCP servers").length - 1;
    session.stdout.emit("resize");
    const framesAfter = session.output().split("Which MCP servers").length - 1;
    expect(framesAfter).toBe(framesBefore + 1);

    session.press("return");
    session.press("return");
    await form;
  });

  it("erases pessimistically when a resize shrinks the terminal mid-form", async () => {
    const session = createSession();
    const sized = Object.assign(session.stdout, { columns: 80, rows: 24 });
    const io = createInteractiveWizardIo({
      colorDepth: 0,
      stdin: session.stdin,
      stdout: session.stdout,
    });
    const wide: WizardQuestion = {
      id: "pick",
      kind: "select",
      label: "Q",
      options: [{ label: "x".repeat(60), value: "x" }],
      prompt: "Pick",
    };

    const form = io.ask([wide]);
    const firstFrame = session.output();
    // The frame painted at 80 columns rewraps taller at 20; erasing with the stale row count
    // would leave artifact rows, so the resize repaint must erase the recounted, larger height.
    const expectedRows = firstFrame
      .split("\n")
      .slice(0, -1)
      .reduce((sum, line) => sum + Math.max(1, Math.ceil(displayWidth(line) / 20)), 0);
    sized.columns = 20;
    session.stdout.emit("resize");
    expect(session.output()).toContain(`\u001b[${String(expectedRows)}A`);

    session.press("return");
    await form;
  });

  it("registers a terminal-restore exit hook only while a form is live", async () => {
    const session = createSession();
    const io = createInteractiveWizardIo({
      colorDepth: 0,
      stdin: session.stdin,
      stdout: session.stdout,
    });
    const before = process.listenerCount("exit");

    const form = io.ask([APPS_QUESTION]);
    expect(process.listenerCount("exit")).toBe(before + 1);
    session.press("c", { ctrl: true });

    await expect(form).resolves.toBe("aborted");
    expect(process.listenerCount("exit")).toBe(before);
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
