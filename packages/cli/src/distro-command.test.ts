import { describe, expect, it } from "vitest";

import { distroCommandProblems } from "./distro-command-validate.js";
import { runCli } from "./index.js";
import { BRANDING, createCapture } from "./testing.js";
import type { CliCommandDefinition, CliCommandInvocation, CliDistro } from "./types.js";

/** A distribution carrying the given commands and nothing else, branded like every fixture. */
function commandDistro(commands: readonly CliCommandDefinition[]): CliDistro {
  return { branding: BRANDING, commands, plugins: [] };
}

/** The fixture command the end-to-end cases share: three flag kinds, examples, and a footer. */
function syncCommand(
  execute: CliCommandDefinition["execute"] = () => Promise.resolve(0),
): CliCommandDefinition {
  return {
    examples: [
      { args: "sync", text: "Synchronize every profile" },
      { args: "sync --tag <tag>", text: "Synchronize one tag only" },
    ],
    execute,
    flags: [
      { description: "Sync even when nothing changed", flag: "--force", kind: "boolean" },
      {
        description: "Profile to synchronize",
        flag: "--name",
        kind: "string",
        placeholder: "<name>",
      },
      {
        description: "Tag to sync; repeatable",
        flag: "--tag",
        kind: "array",
        placeholder: "<tag>",
      },
    ],
    helpFooters: ["Exit codes: 0 synchronized · 2 invalid usage · 3 operational failures"],
    summary: "Synchronize agent profiles",
    word: "sync",
  };
}

describe("distribution commands", () => {
  it("runs a registered command with parsed flags and positionals", async () => {
    const invocations: CliCommandInvocation[] = [];
    const capture = createCapture([
      "sync",
      "--tag",
      "a",
      "remote",
      "--tag",
      "b",
      "--force",
      "--name",
      "prod",
    ]);

    const exitCode = await runCli(
      commandDistro([
        syncCommand((invocation) => {
          invocations.push(invocation);
          invocation.stdout.write("synchronized\n");
          return Promise.resolve(0);
        }),
      ]),
      capture.runtime,
    );

    expect(exitCode).toBe(0);
    expect(capture.stdout.text).toBe("synchronized\n");
    const invocation = invocations[0];
    expect(invocation).toBeDefined();
    expect(invocation?.flags).toEqual({ "--force": true, "--name": "prod", "--tag": ["a", "b"] });
    expect(invocation?.positionals).toEqual(["remote"]);
    expect(invocation?.branding).toBe(BRANDING);
    expect(invocation?.colorDepth).toBe(0);
    expect(invocation?.cwd).toBe(capture.runtime.cwd);
    expect(invocation?.env["PATH"]).toBe("/usr/bin");
    expect(invocation?.homeDir).toBe("/fixture/home");
  });

  it("leaves undeclared flags absent and reports declared defaults", async () => {
    const invocations: CliCommandInvocation[] = [];
    const capture = createCapture(["sync"]);

    const exitCode = await runCli(
      commandDistro([
        syncCommand((invocation) => {
          invocations.push(invocation);
          return Promise.resolve(1);
        }),
      ]),
      capture.runtime,
    );

    expect(exitCode).toBe(1);
    expect(invocations[0]?.flags).toEqual({ "--force": false, "--name": undefined, "--tag": [] });
    expect(invocations[0]?.positionals).toEqual([]);
  });

  it("renders the command's help screen from the same definition the parser uses", async () => {
    const capture = createCapture(["sync", "--help"]);

    const exitCode = await runCli(commandDistro([syncCommand()]), capture.runtime);

    expect(exitCode).toBe(0);
    expect(capture.stdout.text).toMatchInlineSnapshot(`
      "acme sync — Synchronize agent profiles

        Everyday use
          acme sync                Synchronize every profile
          acme sync --tag <tag>    Synchronize one tag only

        Options
          --force                  Sync even when nothing changed
          --name <name>            Profile to synchronize
          --tag <tag>              Tag to sync; repeatable

        Advanced
          --no-color               Disable terminal colors

        Exit codes: 0 synchronized · 2 invalid usage · 3 operational failures
      "
    `);
  });

  it("lists the command on the root help screen after the built-in rows", async () => {
    const capture = createCapture([]);

    const exitCode = await runCli(commandDistro([syncCommand()]), capture.runtime);

    expect(exitCode).toBe(0);
    expect(capture.stdout.text).toContain("acme sync");
    expect(capture.stdout.text).toContain("Synchronize agent profiles");
    // The built-in workflow rows keep their order; the distribution row extends the section.
    expect(capture.stdout.text.indexOf("acme undo")).toBeLessThan(
      capture.stdout.text.indexOf("acme sync"),
    );
  });

  it("lists the command on the unknown-command redirect screen", async () => {
    const capture = createCapture(["synk"]);

    const exitCode = await runCli(commandDistro([syncCommand()]), capture.runtime);

    expect(exitCode).toBe(2);
    expect(capture.stderr.text).toContain("unknown command 'synk'");
    expect(capture.stderr.text).toContain("acme sync");
  });

  it("keeps clipanion's message for a bad flag on a registered command", async () => {
    const capture = createCapture(["sync", "--bogus"]);

    const exitCode = await runCli(commandDistro([syncCommand()]), capture.runtime);

    expect(exitCode).toBe(2);
    expect(capture.stderr.text).toContain("--bogus");
    expect(capture.stderr.text).not.toContain("unknown command");
  });

  it("reports a throwing command as an operational failure", async () => {
    const capture = createCapture(["sync"]);

    const exitCode = await runCli(
      commandDistro([syncCommand(() => Promise.reject(new Error("remote unreachable")))]),
      capture.runtime,
    );

    expect(exitCode).toBe(3);
    expect(capture.stderr.text).toContain("Acme Doctor: remote unreachable");
  });

  it("fails the run at startup when a definition is invalid", async () => {
    const capture = createCapture(["check"]);

    const exitCode = await runCli(
      commandDistro([{ ...syncCommand(), word: "undo" }]),
      capture.runtime,
    );

    expect(exitCode).toBe(3);
    expect(capture.stderr.text).toContain("cannot register the distribution's commands");
    expect(capture.stderr.text).toContain("reserved command word");
  });
});

describe("distroCommandProblems", () => {
  const execute = (): Promise<0> => Promise.resolve(0);

  it("accepts a well-formed list", () => {
    expect(
      distroCommandProblems([
        { execute, summary: "One", word: "one" },
        {
          execute,
          flags: [{ description: "Flag", flag: "--flag", kind: "boolean" }],
          summary: "Two",
          word: "two-2",
        },
      ]),
    ).toEqual([]);
  });

  it("collects every problem across every definition", () => {
    expect(
      distroCommandProblems([
        { execute, summary: "Shadowing", word: "check" },
        { execute, summary: "Shouting", word: "Sync" },
        { execute, summary: "First", word: "twice" },
        { execute, summary: "Second", word: "twice" },
        {
          execute,
          flags: [
            { description: "Short", flag: "-f", kind: "boolean" },
            { description: "Reserved", flag: "--help", kind: "boolean" },
            { description: "First", flag: "--tag", kind: "string" },
            { description: "Second", flag: "--tag", kind: "array" },
          ],
          summary: "Flags",
          word: "flags",
        },
      ]),
    ).toEqual([
      'Command "check" claims a reserved command word.',
      'Command "Sync" must be a lowercase kebab-case word of at most 24 characters, starting with a letter.',
      'Command "twice" is declared more than once.',
      'Command "flags" flag "-f" must be a lowercase kebab-case long flag such as --tag.',
      'Command "flags" flag "--help" claims a reserved flag.',
      'Command "flags" flag "--tag" is declared more than once.',
    ]);
  });
});
