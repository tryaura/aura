import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { confirmFixes } from "./fix-confirmation.js";

interface TerminalSession {
  readonly output: () => string;
  readonly press: (name: string) => void;
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
}

function createTerminalSession(): TerminalSession {
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: (): void => {
      // The wizard engine toggles raw mode; this fixture only needs the call to exist.
    },
  });
  const stdout = Object.assign(new PassThrough(), { isTTY: true });
  stdout.setEncoding("utf8");
  const chunks: string[] = [];
  stdout.on("data", (chunk: string) => {
    chunks.push(chunk);
  });

  return {
    output: () => chunks.join(""),
    press: (name) => {
      stdin.emit("keypress", undefined, {
        ctrl: false,
        meta: false,
        name,
        sequence: undefined,
        shift: false,
      });
    },
    stdin,
    stdout,
  };
}

describe("confirmFixes", () => {
  it("routes the plain --fix confirmation through the wizard Apply/Cancel form", async () => {
    const session = createTerminalSession();

    const confirmation = confirmFixes(
      { colorDepth: 0, stdin: session.stdin, stdout: session.stdout, yes: false },
      undefined,
    );
    expect(session.output()).toContain("Apply this fix plan?");
    expect(session.output()).toContain("Apply");
    expect(session.output()).toContain("Cancel");
    session.press("return");

    await expect(confirmation).resolves.toBe("accepted");
  });

  it("declines when the wizard form resolves on Cancel", async () => {
    const session = createTerminalSession();

    const confirmation = confirmFixes(
      { colorDepth: 0, stdin: session.stdin, stdout: session.stdout, yes: false },
      undefined,
    );
    session.press("down");
    session.press("return");

    await expect(confirmation).resolves.toBe("declined");
  });

  it("keeps non-TTY behavior unchanged: unavailable without a wizard", async () => {
    await expect(
      confirmFixes(
        { colorDepth: 0, stdin: new PassThrough(), stdout: new PassThrough(), yes: false },
        undefined,
      ),
    ).resolves.toBe("unavailable");
  });

  it("accepts without prompting under --yes", async () => {
    await expect(
      confirmFixes(
        { colorDepth: 0, stdin: new PassThrough(), stdout: new PassThrough(), yes: true },
        undefined,
      ),
    ).resolves.toBe("accepted");
  });
});
