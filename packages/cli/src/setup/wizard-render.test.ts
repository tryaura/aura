/* eslint-disable max-lines -- one snapshot matrix pins every frame the renderer can produce. */
import { describe, expect, it } from "vitest";

import {
  renderAnsweredSummary,
  renderWizardFrame,
  type WizardFrame,
  type WizardQuestionView,
} from "./wizard-render.js";
import type { WizardQuestion } from "./wizard-types.js";

const APPS_QUESTION: WizardQuestion = {
  freeText: true,
  id: "apps",
  kind: "select",
  label: "Apps",
  options: [
    { description: "Both installed and authed.", label: "Claude Code + Cursor", value: "both" },
    { label: "Claude Code only", value: "claude" },
  ],
  prompt: "Which apps should Aura manage?",
};

const MCP_QUESTION: WizardQuestion = {
  id: "mcp",
  kind: "multiselect",
  label: "MCP",
  options: [
    { label: "linear", value: "linear" },
    { label: "context7", value: "context7" },
  ],
  prompt: "Which MCP servers should every managed app get?",
};

function view(
  question: WizardQuestion,
  overrides: Partial<WizardQuestionView> = {},
): WizardQuestionView {
  return {
    answered: false,
    question,
    selected: new Set(),
    text: "",
    ...overrides,
  };
}

describe("renderWizardFrame", () => {
  it("renders a select question with tab bar, cursor, and free-text row", () => {
    const frame: WizardFrame = {
      activeTab: 0,
      cursorRow: 0,
      questions: [view(APPS_QUESTION), view(MCP_QUESTION)],
    };

    expect(renderWizardFrame(frame, 0)).toMatchInlineSnapshot(`
      " ▶ Apps ☐ │ MCP ☐ │ Submit

       Which apps should Aura manage?

      ❯ 1. Claude Code + Cursor
            Both installed and authed.
        2. Claude Code only
        3. Type something.

       ↑/↓ move · ←/→ steps · ↵ select · esc cancel
      "
    `);
  });

  it("renders a multiselect question with checkboxes and an answered tab", () => {
    const frame: WizardFrame = {
      activeTab: 1,
      cursorRow: 1,
      questions: [
        view(APPS_QUESTION, { answered: true, selected: new Set(["both"]) }),
        view(MCP_QUESTION, { selected: new Set(["linear"]) }),
      ],
    };

    expect(renderWizardFrame(frame, 0)).toMatchInlineSnapshot(`
      " ✔ Apps │ ▶ MCP ☐ │ Submit

       Which MCP servers should every managed app get?

        1. ☑ linear
      ❯ 2. ☐ context7

       ↑/↓ move · space toggle · ←/→ steps · ↵ select · esc cancel
      "
    `);
  });

  it("renders a locked Submit tab as the list of missing steps", () => {
    const frame: WizardFrame = {
      activeTab: 2,
      cursorRow: 0,
      questions: [
        view(APPS_QUESTION, { answered: true, selected: new Set(["both"]) }),
        view(MCP_QUESTION),
      ],
    };

    expect(renderWizardFrame(frame, 0)).toMatchInlineSnapshot(`
      " ✔ Apps │ MCP ☐ │ ▶ Submit

       Submit unlocks once every step below is answered.

       ✔ Apps  Claude Code + Cursor
       ☐ MCP  (unanswered)

       ←/→ steps · esc cancel
      "
    `);
  });

  it("renders an unlocked Submit tab as a review of every answer", () => {
    const frame: WizardFrame = {
      activeTab: 2,
      cursorRow: 0,
      questions: [
        view(APPS_QUESTION, { answered: true, selected: new Set(["both"]) }),
        view(MCP_QUESTION, { answered: true, selected: new Set(["linear"]) }),
      ],
    };

    expect(renderWizardFrame(frame, 0)).toMatchInlineSnapshot(`
      " ✔ Apps │ ✔ MCP │ ▶ Submit

       Review your answers, then press ↵ to continue.

       ✔ Apps  Claude Code + Cursor
       ✔ MCP  linear

       ↵ submit · ←/→ steps · esc cancel
      "
    `);
  });

  it("maps the whole flow around the live form's questions", () => {
    const frame: WizardFrame = {
      activeTab: 0,
      cursorRow: 0,
      flow: {
        completed: [{ label: "Applications" }, { label: "Instructions" }],
        upcoming: [{ label: "Baseline", compactLabel: "Base" }],
      },
      questions: [view(MCP_QUESTION)],
    };

    const bar = renderWizardFrame(frame, 0).split("\n")[0];
    expect(bar).toBe(" ✔ Applications │ ✔ Instructions │ ▶ MCP ☐ │ Baseline ☐ │ Submit");
  });

  it("renders the flow's Submit form as the active Submit tab", () => {
    const submitQuestion: WizardQuestion = {
      id: "confirm",
      kind: "select",
      label: "Submit",
      options: [
        { label: "Apply", value: "apply" },
        { label: "Cancel", value: "cancel" },
      ],
      prompt: "Apply this plan?",
    };
    const frame: WizardFrame = {
      activeTab: 0,
      cursorRow: 0,
      flow: {
        completed: [{ label: "Applications" }, { label: "Snippets" }],
        submit: true,
        upcoming: [],
      },
      questions: [view(submitQuestion)],
    };

    const bar = renderWizardFrame(frame, 0).split("\n")[0];
    expect(bar).toBe(" ✔ Applications │ ✔ Snippets │ ▶ Submit");
  });

  it("windows a body taller than the terminal around the cursor instead of overflowing", () => {
    const tall: WizardQuestion = {
      id: "snippets",
      kind: "multiselect",
      label: "Snippets",
      options: Array.from({ length: 12 }, (_, index) => ({
        description: `Description ${String(index + 1)}.`,
        label: `Snippet ${String(index + 1)}`,
        value: `snippet-${String(index + 1)}`,
      })),
      prompt: "Choose snippets",
    };
    const frame: WizardFrame = {
      activeTab: 0,
      cursorRow: 11,
      questions: [view(tall)],
    };

    const rendered = renderWizardFrame(frame, 0, { columns: 80, rows: 14 });
    const rows = rendered.split("\n");

    // The frame must fit the terminal, or the engine's cursor-up erasure leaks rows above.
    expect(rows.length - 1).toBeLessThanOrEqual(14 - 1);
    expect(rendered).toContain("↑");
    expect(rendered).toContain("more");
    // The cursor row stays visible inside the window.
    expect(rendered).toContain("❯ 12. ☐ Snippet 12");
  });

  it("keeps the step row static and maps chain progress in a └ sub-row", () => {
    const sources: WizardQuestion = { ...MCP_QUESTION, label: "Sources" };
    const frame: WizardFrame = {
      activeTab: 0,
      cursorRow: 0,
      flow: {
        completed: [{ label: "Applications" }],
        step: { compactLabel: "Instr", label: "Instructions" },
        sub: { completed: [{ label: "Global" }], upcoming: [{ label: "Archive" }] },
        upcoming: [{ label: "Snippets" }, { compactLabel: "Base", label: "Baseline" }],
      },
      questions: [view(sources)],
    };

    const rows = renderWizardFrame(frame, 0).split("\n");
    expect(rows[0]).toBe(" ✔ Applications │ ▶ Instructions ☐ │ Snippets ☐ │ Baseline ☐ │ Submit");
    expect(rows[1]).toBe(" └ ✔ Global │ ▶ Sources ☐ │ Archive ☐");
    expect(rows[2]).toBe("");
  });

  it("shows no sub-row when the lone question is the step itself", () => {
    const apps: WizardQuestion = { ...MCP_QUESTION, label: "Applications" };
    const frame: WizardFrame = {
      activeTab: 0,
      cursorRow: 0,
      flow: {
        completed: [],
        step: { label: "Applications" },
        upcoming: [{ label: "Snippets" }],
      },
      questions: [view(apps)],
    };

    const rows = renderWizardFrame(frame, 0).split("\n");
    expect(rows[0]).toBe(" ▶ Applications ☐ │ Snippets ☐ │ Submit");
    expect(rows[1]).toBe("");
  });

  it("degrades each bar row independently when the terminal narrows", () => {
    const sources: WizardQuestion = { ...MCP_QUESTION, label: "Sources" };
    const frame: WizardFrame = {
      activeTab: 0,
      cursorRow: 0,
      flow: {
        completed: [{ label: "Applications", compactLabel: "Apps" }],
        step: { compactLabel: "Instr", label: "Instructions" },
        sub: { completed: [{ label: "Global" }], upcoming: [{ label: "Archive" }] },
        upcoming: [{ compactLabel: "Base", label: "Baseline" }],
      },
      questions: [view(sources)],
    };

    const rows = renderWizardFrame(frame, 0, { columns: 40, rows: 24 }).split("\n");
    expect(rows[0]).toBe(" ✔ Apps │ ▶ Instr ☐ │ Base ☐ │ Submit");
    expect(rows[1]).toBe(" └ ✔ Global │ ▶ Sources ☐ │ Archive ☐");

    const glyphRows = renderWizardFrame(frame, 0, { columns: 30, rows: 24 }).split("\n");
    expect(glyphRows[0]).toBe(" ✔ │ ▶ Instructions ☐ │ ☐ │ Submit");
    expect(glyphRows[1]).toBe(" └ ✔ │ ▶ Sources ☐ │ ☐");
  });

  it("charges the sub-row against the body window so tall frames still fit", () => {
    const tall: WizardQuestion = {
      id: "snippets",
      kind: "multiselect",
      label: "Sources",
      options: Array.from({ length: 12 }, (_, index) => ({
        description: `Description ${String(index + 1)}.`,
        label: `Snippet ${String(index + 1)}`,
        value: `snippet-${String(index + 1)}`,
      })),
      prompt: "Choose snippets",
    };
    const frame: WizardFrame = {
      activeTab: 0,
      cursorRow: 11,
      flow: {
        completed: [],
        step: { label: "Instructions" },
        sub: { completed: [{ label: "Global" }], upcoming: [] },
        upcoming: [],
      },
      questions: [view(tall)],
    };

    const rendered = renderWizardFrame(frame, 0, { columns: 80, rows: 14 });
    expect(rendered.split("\n").length - 1).toBeLessThanOrEqual(14 - 1);
    expect(rendered).toContain("❯ 12. ☐ Snippet 12");
  });

  it("degrades the tab bar to compact labels, then glyphs, before ever truncating", () => {
    const long: WizardQuestion = {
      ...APPS_QUESTION,
      compactLabel: "Apps",
      label: "Applications",
    };
    const frame: WizardFrame = {
      activeTab: 0,
      cursorRow: 0,
      questions: [view(long), view(MCP_QUESTION, { answered: true })],
    };

    const wide = renderWizardFrame(frame, 0).split("\n")[0];
    expect(wide).toBe(" ▶ Applications ☐ │ ✔ MCP │ Submit");

    const compact = renderWizardFrame(frame, 0, { columns: 30, rows: 24 }).split("\n")[0];
    expect(compact).toBe(" ▶ Apps ☐ │ ✔ MCP │ Submit");

    const glyphs = renderWizardFrame(frame, 0, { columns: 24, rows: 24 }).split("\n")[0];
    expect(glyphs).toBe(" ▶ Applications ☐ │ ✔ │ Submit");
  });

  it("shows the free-text draft on its row and in the summary", () => {
    const frame: WizardFrame = {
      activeTab: 0,
      cursorRow: 2,
      questions: [view(APPS_QUESTION, { text: "codex" })],
    };

    expect(renderWizardFrame(frame, 0)).toContain("❯ 3. codex");
    expect(
      renderAnsweredSummary([
        view(APPS_QUESTION, { answered: true, selected: new Set(), text: "codex" }),
      ]),
    ).toBe(" ✔ Apps  codex\n");
  });

  it("emits escape sequences only when the terminal has color", () => {
    const frame: WizardFrame = {
      activeTab: 0,
      cursorRow: 0,
      questions: [view(APPS_QUESTION)],
    };

    expect(renderWizardFrame(frame, 0)).not.toContain("\u001b[");
    const colored = renderWizardFrame(frame, 8);
    expect(colored).toContain("\u001b[7m");
    expect(colored).toContain("\u001b[1mWhich apps should Aura manage?\u001b[22m");
  });

  it("neutralizes control characters in question text", () => {
    const hostile: WizardQuestion = {
      ...APPS_QUESTION,
      options: [{ label: "evil\u001b[2Klabel", value: "evil" }],
      prompt: "prompt\u001b[1A",
    };
    const frame: WizardFrame = { activeTab: 0, cursorRow: 0, questions: [view(hostile)] };

    expect(renderWizardFrame(frame, 0)).not.toContain("\u001b");
  });

  it("renders grouped, disabled snippet rows and a sanitized preview", () => {
    const snippets: WizardQuestion = {
      id: "snippets",
      kind: "multiselect",
      label: "Snippets",
      options: [
        {
          description: "Commit rules.",
          group: "git",
          label: "Commits",
          preview: "# Rules\n\u001b[2KKeep subjects short.",
          value: "official/commits",
        },
        {
          description: "The source could not be read.",
          disabled: true,
          group: "safety",
          label: "Safety",
          value: "official/safety",
        },
      ],
      prompt: "Choose snippets",
    };
    const grouped = renderWizardFrame(
      { activeTab: 0, cursorRow: 0, questions: [view(snippets)] },
      0,
    );

    expect(grouped).toContain(" git\n❯ 1. ☐ Commits");
    expect(grouped).toContain(" safety\n  2. ☐ Safety — unavailable");
    expect(grouped).toContain("p preview");
    const preview = renderWizardFrame(
      {
        activeTab: 0,
        cursorRow: 0,
        preview: { content: "# Rules\n\u001b[2KKeep subjects short.", offset: 0, title: "Commits" },
        questions: [view(snippets)],
      },
      0,
    );
    expect(preview).toContain("# Rules\n [2KKeep subjects short.");
    expect(preview).not.toContain("\u001b");
  });

  it("clips and wraps a preview to the viewport instead of overflowing it", () => {
    const body = ["short", "x".repeat(100), "tail one", "tail two"].join("\n");

    const rendered = renderWizardFrame(previewFrame(body, 0), 0, { columns: 40, rows: 10 });

    // Ten rows less five of chrome leaves five: "short" and the four rows the long line wraps into.
    expect(rendered.split("\n")).toEqual([
      "Commits",
      "",
      "short",
      "x".repeat(40),
      "x".repeat(40),
      "x".repeat(20),
      "tail one",
      "",
      " \u2191/\u2193 scroll \u00b7 1 more line \u00b7 esc/\u21b5 return to picker",
      "",
    ]);
    // The frame has to fit, or the engine's cursor-up repaint lands somewhere other than its start.
    expect(rendered.split("\n").length - 1).toBeLessThanOrEqual(10);
  });

  it("scrolls a preview by its offset and drops the counter at the end", () => {
    const body = ["one", "two", "three", "four", "five"].join("\n");

    const rendered = renderWizardFrame(previewFrame(body, 2), 0, { columns: 20, rows: 8 });

    expect(rendered).toContain("three\nfour\nfive");
    expect(rendered).not.toContain("more line");
  });

  it("clamps an offset past the end to the last screenful", () => {
    const body = ["one", "two", "three", "four", "five"].join("\n");

    const rendered = renderWizardFrame(previewFrame(body, 99), 0, { columns: 20, rows: 8 });

    expect(rendered).toContain("three\nfour\nfive");
  });
});

function previewFrame(content: string, offset: number): WizardFrame {
  const question: WizardQuestion = {
    id: "snippets",
    kind: "multiselect",
    label: "Snippets",
    options: [{ label: "Commits", preview: content, value: "official/commits" }],
    prompt: "Choose snippets",
  };
  return {
    activeTab: 0,
    cursorRow: 0,
    preview: { content, offset, title: "Commits" },
    questions: [view(question)],
  };
}
