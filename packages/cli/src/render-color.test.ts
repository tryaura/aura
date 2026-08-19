import { describe, expect, it } from "vitest";

import { runCli } from "./run.js";
import { createCapture, distro, findingPlugin } from "./testing.js";

describe("check output styling", () => {
  it("uses color only to reinforce visible glyphs and verdict text", async () => {
    const plain = createCapture(["check"]);
    const colored = createCapture(["check"]);
    const errored = createCapture(["check"]);
    const disabled = createCapture(["check", "--no-color"]);
    await runCli(distro([findingPlugin("warn")]), plain.runtime);
    await runCli(distro([findingPlugin("warn")]), { ...colored.runtime, colorDepth: 8 });
    await runCli(distro([findingPlugin("error")]), { ...errored.runtime, colorDepth: 8 });
    await runCli(distro([findingPlugin("warn")]), { ...disabled.runtime, colorDepth: 8 });

    expect(plain.stdout.text).not.toContain("\u001b[");
    expect(colored.stdout.text).toContain("\u001b[33m! warn finding\u001b[39m");
    expect(colored.stdout.text).toContain(
      "\u001b[33mResult: attention recommended\u001b[39m (\u001b[32mexit 0\u001b[39m)",
    );
    expect(errored.stdout.text).toContain(
      "\u001b[33mResult: action required\u001b[39m (\u001b[32mexit 0\u001b[39m)",
    );
    expect(disabled.stdout.text).not.toContain("\u001b[");
  });

  it("keeps an injected stream free of color whatever the surrounding process forces", async () => {
    const escape = String.fromCharCode(27);
    const forced = createCapture(["check"]);
    const asked = createCapture(["check"]);

    // FORCE_COLOR answers a question about the process's own terminal, never about a stream an
    // embedder handed in: only the embedder's own colorDepth can put escapes in its capture.
    await runCli(distro([findingPlugin("warn")]), {
      ...forced.runtime,
      environmentVariables: { FORCE_COLOR: "1", PATH: "/usr/bin" },
    });
    await runCli(distro([findingPlugin("warn")]), { ...asked.runtime, colorDepth: 8 });

    expect(forced.stdout.text).not.toContain(escape);
    expect(asked.stdout.text).toContain(`${escape}[33m`);
  });

  it("keeps JSON unchanged and free of styling", async () => {
    const capture = createCapture(["check", "--json"]);

    expect(
      await runCli(distro([findingPlugin("warn")]), { ...capture.runtime, colorDepth: 8 }),
    ).toBe(0);

    expect(capture.stdout.text).not.toContain("\u001b[");
    expect(JSON.parse(capture.stdout.text)).toMatchObject({
      kind: "check-report",
      schemaVersion: 1,
      status: "warning",
      summary: { exitCode: 0 },
    });
  });
});
