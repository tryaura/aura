import { describe, expect, it } from "vitest";

import {
  renderCheckHelp,
  renderRootHelp,
  renderSetupHelp,
  renderUndoHelp,
  renderUnknownCommand,
} from "./help.js";
import { BRANDING } from "./testing.js";
import type { CliBranding } from "./types.js";
import { renderUpdateHelp } from "./update/help.js";

describe("help screens", () => {
  it("renders the root screen action-first", () => {
    expect(renderRootHelp(BRANDING)).toMatchInlineSnapshot(`
      "Acme Doctor 1.2.3 — Agent setup doctor

        Every AI coding agent keeps its own rules and its own tool settings, in its own
        files. Aura reads all of them, tells you where they disagree or are broken, and
        fixes them after you say yes - so every agent works from the same instructions.

        Get started
          acme setup               Set up this machine interactively and converge it

        Everyday use
          acme check               Inspect the current AI agent setup
          acme check --fix         Preview fixes and apply them after confirming
          acme undo                Restore the most recent Aura backup

        Help
          acme <command> --help    Full flag reference for a command
          acme --version           Print the version and exit

        Advanced
          --no-color               Disable terminal colors

        Docs: https://example.com/docs
      "
    `);
  });

  it("drops the headline parts branding does not define", () => {
    const bare: CliBranding = { command: "aura", displayName: "Aura" };
    const help = renderRootHelp(bare);

    expect(help.startsWith("Aura\n")).toBe(true);
    // The paragraph explains the tool, not the distribution, so it survives bare branding.
    expect(help).toContain("Every AI coding agent keeps its own rules");
    expect(help).not.toContain("Docs:");
    // Without a version the flag is never registered (run.boundary.ts), so the row must not advertise it.
    expect(help).not.toContain("--version");
  });

  it("shows the update command only for a standalone entry point", () => {
    expect(renderRootHelp(BRANDING)).not.toContain("acme update");
    expect(renderRootHelp(BRANDING, true)).toContain(
      "acme update              Check now, install an update, and exit",
    );
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
          --online                      Probe remote MCP URLs with bounded network requests

        Reporting
          --verbose                     Expand occurrences and locations; add passed checks and applications
          --detail                      Include the failing plugin's own error text

        Configuration
          --preset <ref>                Use a plugin:, npm:, HTTPS, or local preset
          --enable <check>              Enable a check; repeatable
          --disable <check>             Disable a check; repeatable
          --severity <check>=<level>    Override info, warn, or error; repeatable
          --threshold <check>=<JSON>    Override a check's threshold object; repeatable
          --no-cache                    Bypass remote preset and skill-catalog cache reads and writes

        Fixing behavior
          --yes                         Apply automatic fixes without asking; required when stdin is not a terminal

        Scripting
          --json                        Emit JSON instead of human output
          --json-version <n>            Select the machine-readable contract version (supported: 1)

        Advanced
          --home <dir>                  Override the home directory
          --no-color                    Disable terminal colors
          --path <dir>                  Override the executable search path

        Exit codes: 0 completed check · 2 usage/state conflicts or no checks · 3 operational failures
      "
    `);
  });

  it("renders the setup screen and points at check afterwards", () => {
    expect(renderSetupHelp(BRANDING, ["snippet", "skill"])).toMatchInlineSnapshot(`
      "acme setup — Set up this machine interactively and converge it

        Everyday use
          acme setup                    Run the setup wizard
          acme setup --dry-run          Stop after the plan summary, write nothing

        Options
          --yes                         Accept every proposed default; required when stdin is not a terminal
          --detail                      Include the full diff of every planned change
          --add <kind>                  Run one setup addition (supported: snippet, skill)

        Configuration
          --preset <ref>                Use a plugin:, npm:, HTTPS, or local preset
          --enable <check>              Enable a check; repeatable
          --disable <check>             Disable a check; repeatable
          --severity <check>=<level>    Override info, warn, or error; repeatable
          --threshold <check>=<JSON>    Override a check's threshold object; repeatable
          --no-cache                    Bypass remote preset and skill-catalog cache reads and writes

        Advanced
          --home <dir>                  Override the home directory
          --no-color                    Disable terminal colors
          --path <dir>                  Override the executable search path

        Consolidating moves the instruction files you select; 'acme undo' restores them

        After setup, run 'acme check' to verify the machine converged

        Exit codes: 0 applied/converged/dry-run/declined · 1 aborted or warnings · 2 conflicts/errors/invalid usage · 3 operational failures
      "
    `);
  });

  it("renders the undo screen with every restore mode", () => {
    expect(renderUndoHelp(BRANDING)).toMatchInlineSnapshot(`
      "acme undo — Restore files from an Aura backup

        Everyday use
          acme undo                Restore the most recent backup
          acme undo --list         List every available backup
          acme undo <backup-id>    Restore one backup by name
          acme undo --dry-run      Show which backup would be restored, write nothing

        Options
          --yes                    Restore without asking; required when stdin is not a terminal
          --detail                 Include the underlying error when restoration fails

        Advanced
          --home <dir>             Override the home directory
          --no-color               Disable terminal colors
          --path <dir>             Override the executable search path

        Exit codes: 0 restored or nothing to undo · 1 aborted or declined at the prompt · 2 conflicts · 3 operational failures
      "
    `);
  });

  it("renders the update screen", () => {
    expect(renderUpdateHelp(BRANDING)).toContain(
      "acme update    Bypass the update cache, install an available update, and exit",
    );
    expect(renderUpdateHelp(BRANDING)).toContain("Available only in a standalone installation");
    expect(renderUpdateHelp(BRANDING)).toContain(
      "Exit codes: 0 current or installed · 1 another update is in progress · 2 unavailable in this environment · 3 operational failure",
    );
  });

  it("redirects an unknown command instead of dumping a parser trace", () => {
    expect(renderUnknownCommand(BRANDING, "chekc")).toMatchInlineSnapshot(`
      "acme: unknown command 'chekc'

        Commands
          acme setup    Set up this machine interactively and converge it
          acme check    Inspect the current AI agent setup
          acme undo     Restore the most recent Aura backup

        Run 'acme --help' for more
      "
    `);
  });

  it("neutralizes control characters in the echoed unknown command", () => {
    const screen = renderUnknownCommand(BRANDING, "bad\u001b[2Jcmd");

    expect(screen).not.toContain("\u001b");
    expect(screen).toContain("unknown command 'bad [2Jcmd'");
  });
});
