import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import { runWizardLoader } from "./wizard-loader.js";

const HIDE_CURSOR = "[?25l";
const SHOW_CURSOR = "[?25h";

interface Harness {
  readonly options: {
    readonly colorDepth: number;
    readonly stdin: RawStdin;
    readonly stdout: Writable;
  };
  readonly stdin: RawStdin;
  readonly written: () => string;
}

/** A readable that claims to be a TTY, recording the raw-mode transitions the loader asks for. */
interface RawStdin extends PassThrough {
  isTTY: boolean;
  rawModes: boolean[];
  setRawMode: (mode: boolean) => void;
}

function harness(): Harness {
  const stdin = new PassThrough() as RawStdin;
  stdin.isTTY = true;
  stdin.rawModes = [];
  stdin.setRawMode = (mode: boolean): void => {
    stdin.rawModes.push(mode);
  };
  const chunks: string[] = [];
  const stdout = new Writable({
    write(chunk: Buffer | string, _encoding, callback): void {
      chunks.push(String(chunk));
      callback();
    },
  });
  return {
    options: { colorDepth: 1, stdin, stdout },
    stdin,
    written: () => chunks.join(""),
  };
}

const REQUEST = { items: [{ id: "acme", label: "Acme Skills" }], prompt: "Loading…" };

describe("runWizardLoader", () => {
  it("holds the terminal for the whole load and gives it back afterwards", async () => {
    const { options, stdin, written } = harness();

    await runWizardLoader(REQUEST, () => Promise.resolve("done"), options);

    expect(stdin.rawModes).toEqual([true, false]);
    expect(written()).toContain(HIDE_CURSOR);
    expect(written().endsWith(SHOW_CURSOR)).toBe(true);
  });

  it("swallows keys struck during the load instead of leaving them for the next form", async () => {
    const { options, stdin } = harness();
    const delivered: string[] = [];

    await runWizardLoader(
      REQUEST,
      async () => {
        stdin.write("jjj");
        await Promise.resolve();
        return "done";
      },
      options,
    );
    stdin.on("data", (chunk: Buffer) => delivered.push(String(chunk)));
    await Promise.resolve();

    expect(delivered).toEqual([]);
  });

  it("gives the terminal back when the task throws", async () => {
    const { options, stdin, written } = harness();

    await expect(
      runWizardLoader(REQUEST, () => Promise.reject(new Error("offline")), options),
    ).rejects.toThrow("offline");

    expect(stdin.rawModes).toEqual([true, false]);
    expect(written().endsWith(SHOW_CURSOR)).toBe(true);
  });

  it("renders no frame and takes no claim when there is nothing to report", async () => {
    const { options, stdin, written } = harness();

    const result = await runWizardLoader(
      { items: [], prompt: "Loading…" },
      () => Promise.resolve("done"),
      options,
    );

    expect(result).toBe("done");
    expect(stdin.rawModes).toEqual([]);
    expect(written()).toBe("");
  });
});
