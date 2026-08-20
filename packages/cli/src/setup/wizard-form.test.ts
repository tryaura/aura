import { describe, expect, it } from "vitest";

import { createFormSession } from "./wizard-form.js";
import type { Keypress, WizardQuestion } from "./wizard-types.js";

function key(name: string, sequence?: string): Keypress {
  return { ctrl: false, meta: false, name, sequence, shift: false };
}

const SKILLS: WizardQuestion = {
  id: "skills",
  kind: "multiselect",
  label: "Skills",
  options: [
    { disabled: true, disabledNote: "unavailable", label: "Acme Skills", value: "source:acme" },
    {
      disabled: true,
      disabledNote: "source no longer publishes this skill",
      label: ".NET 11",
      value: "dotnet11",
    },
    { label: "React best practices", value: "react" },
  ],
  prompt: "Which skills should Aura install?",
};

describe("createFormSession", () => {
  it("opens the cursor past leading disabled rows so the first space marks a row", () => {
    const session = createFormSession([SKILLS]);

    expect(session.frame().cursorRow).toBe(2);
    expect(session.handle(key("space"))).toBe("repaint");
    expect(session.views()[0]?.selected).toEqual(new Set(["react"]));
  });

  it("opens on the first row when every row is disabled", () => {
    const session = createFormSession([{ ...SKILLS, options: SKILLS.options.slice(0, 2) }]);

    expect(session.frame().cursorRow).toBe(0);
    expect(session.handle(key("space"))).toBe("none");
  });
});
