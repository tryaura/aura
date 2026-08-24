import { describe, expect, it } from "vitest";

import { arrayFlag, booleanFlag, stringFlag } from "./distro-command-flags.js";
import { runCli } from "./index.js";
import { BRANDING, createCapture } from "./testing.js";
import type { CliCommandDefinition, CliDistro } from "./types.js";

/** The fixture command every case runs: one flag of each kind, accessed through the helpers. */
function syncCommand(execute: CliCommandDefinition["execute"]): CliCommandDefinition {
  return {
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
    summary: "Synchronize agent profiles",
    word: "sync",
  };
}

function distro(command: CliCommandDefinition): CliDistro {
  return { branding: BRANDING, commands: [command], plugins: [] };
}

describe("typed flag helpers", () => {
  it("narrows each declared kind to its parsed value", async () => {
    const seen: unknown[] = [];
    const capture = createCapture(["sync", "--force", "--tag", "a"]);

    const exitCode = await runCli(
      distro(
        syncCommand((invocation) => {
          seen.push(
            booleanFlag(invocation, "--force"),
            stringFlag(invocation, "--name"),
            arrayFlag(invocation, "--tag"),
          );
          return Promise.resolve(0);
        }),
      ),
      capture.runtime,
    );

    expect(exitCode).toBe(0);
    expect(seen).toEqual([true, undefined, ["a"]]);
  });

  it("throws on a flag the definition never declared", async () => {
    const capture = createCapture(["sync"]);

    const exitCode = await runCli(
      distro(
        syncCommand((invocation) => {
          booleanFlag(invocation, "--forc");
          return Promise.resolve(0);
        }),
      ),
      capture.runtime,
    );

    expect(exitCode).toBe(3);
    expect(capture.stderr.text).toContain('Flag "--forc" is not declared on this command.');
  });

  it("throws when the declared kind does not match the accessor", async () => {
    const capture = createCapture(["sync"]);

    const exitCode = await runCli(
      distro(
        syncCommand((invocation) => {
          booleanFlag(invocation, "--name");
          return Promise.resolve(0);
        }),
      ),
      capture.runtime,
    );

    expect(exitCode).toBe(3);
    expect(capture.stderr.text).toContain('Flag "--name" is not declared as a boolean flag.');
  });
});
