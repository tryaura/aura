import { describe, expect, it } from "vitest";

import { renderCheckHelp, renderRootHelp, renderSetupHelp, renderUnknownCommand } from "./help.js";
import { BRANDING } from "./testing.js";
import type { CliBranding } from "./types.js";

describe("help screens", () => {
  it("renders the root screen action-first", () => {
    expect(renderRootHelp(BRANDING)).toMatchInlineSnapshot(`
      "Acme Doctor 1.2.3 — Agent setup doctor

        Get started
          acme setup               Set up this machine interactively and converge it

        Everyday use
          acme check               Inspect the current AI agent setup
          acme check --fix         Preview fixes and apply them after confirming

        Help
          acme <command> --help    Full flag reference for a command

        Docs: https://example.com/docs
      "
    `);
  });

  it("drops the headline parts branding does not define", () => {
    const bare: CliBranding = { command: "aura", displayName: "Aura" };
    const help = renderRootHelp(bare);

    expect(help.startsWith("Aura\n")).toBe(true);
    expect(help).not.toContain("Docs:");
  });

  it("renders the check screen grouped by task, plumbing last", () => {
    expect(renderCheckHelp(BRANDING)).toMatchInlineSnapshot(`
      "acme check — Inspect the current AI agent setup

        Everyday use
          acme check                    Run all checks
          acme check --fix              Preview fixes and apply them after confirming
          acme check --fix --dry-run    Show what fixing would change, write nothing

        Narrow it down
          --only <filter>               Run one check ID, category, or application; repeatable
          --explain <id>                Explain one check without scanning
          --detail                      Include the failing plugin's own error text

        Fixing behavior
          --interactive                 With --fix, walk through guided remediation choices
          --yes                         Apply without asking; required when stdin is not a terminal

        Scripting
          --json                        Emit JSON instead of human output
          --json-version <n>            Select the machine-readable contract version (supported: 1)

        Advanced
          --home <dir>                  Override the home directory
          --path <dir>                  Override the executable search path

        Exit codes: 0 clean · 1 warnings · 2 errors or usage/state conflicts · 3 operational failures
      "
    `);
  });

  it("renders the setup screen and points at check afterwards", () => {
    expect(renderSetupHelp(BRANDING)).toMatchInlineSnapshot(`
      "acme setup — Set up this machine interactively and converge it

        Everyday use
          acme setup              Run the setup wizard
          acme setup --dry-run    Stop after the plan summary, write nothing

        Options
          --yes                   Accept every proposed default; required when stdin is not a terminal
          --detail                Include the full diff of every planned change

        Advanced
          --home <dir>            Override the home directory
          --path <dir>            Override the executable search path

        After setup, run 'acme check' to verify the machine converged
      "
    `);
  });

  it("redirects an unknown command instead of dumping a parser trace", () => {
    expect(renderUnknownCommand(BRANDING, "chekc")).toMatchInlineSnapshot(`
      "acme: unknown command 'chekc'

        Commands
          acme setup    Set up this machine interactively and converge it
          acme check    Inspect the current AI agent setup

        Run 'acme --help' for more
      "
    `);
  });
});
