import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";

import { beforeAll, describe, expect, it } from "vitest";

import {
  eligibleInstallation,
  type EligibilityRefusal,
  type EligibilityRequest,
} from "./eligibility.js";

let directory = "";
let executablePath = "";
let symlinkPath = "";

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "aura-update-eligibility-"));
  executablePath = join(directory, "acme");
  symlinkPath = join(directory, "acme-link");
  await writeFile(executablePath, "binary", { mode: 0o755 });
  await symlink(executablePath, symlinkPath);
});

describe("update eligibility", () => {
  it("accepts an interactive standalone run of a stamped release", async () => {
    expect(await decide()).toEqual({
      installation: {
        executablePath,
        target: "darwin-arm64",
        version: "1.3.0",
      },
      kind: "eligible",
    });
  });

  it("accepts an argument-free run", async () => {
    expect((await decide({ argv: [] })).kind).toBe("eligible");
  });

  it.each([
    { argv: ["--help"], label: "explicit help" },
    { argv: ["check", "-h"], label: "command help" },
    { argv: ["--version"], label: "version output" },
  ])("refuses to delay $label", async ({ argv }) => {
    expect(await refusal({ argv })).toBe("informational-run");
  });

  /**
   * Each clause names itself. A user never sees these, but the author of a distribution whose
   * updates are not happening has no other way to tell which clause fired.
   */
  it.each([
    {
      label: "the distribution has no version",
      patch: { version: undefined },
      reason: "unstamped-version",
    },
    {
      label: "the version is an unstamped source build",
      patch: { version: "0.0.0" },
      reason: "unstamped-version",
    },
    {
      label: "the version is not canonical semver",
      patch: { version: "1.3" },
      reason: "unstamped-version",
    },
  ] as const)("refuses when $label", async ({ patch, reason }) => {
    expect(await refusal(patch)).toBe(reason);
  });

  it.each([
    { arch: "arm64", platform: "darwin", target: "darwin-arm64" },
    { arch: "x64", platform: "darwin", target: "darwin-x64" },
    { arch: "arm64", platform: "linux", target: "linux-arm64" },
    { arch: "x64", platform: "linux", target: "linux-x64" },
  ] as const)("resolves $platform $arch to $target", async (machine) => {
    const eligible = await decide({
      current: current({ arch: machine.arch, platform: machine.platform }),
    });
    expect(eligible.kind === "eligible" ? eligible.installation.target : undefined).toBe(
      machine.target,
    );
  });

  /**
   * A symlink means some other installation owns this name — a package manager's shim, a version
   * manager's current-release pointer. Replacing it would either detach it from its manager or
   * write straight through it into a directory Aura does not own.
   */
  it("refuses to replace a symlink", async () => {
    expect(await refusal({ current: current({ execPath: symlinkPath }) })).toBe(
      "not-a-regular-file",
    );
  });

  it("refuses an executable that is not there", async () => {
    expect(await refusal({ current: current({ execPath: join(directory, "absent") }) })).toBe(
      "not-a-regular-file",
    );
  });

  it.each(["off", "0", "false", "no", "OFF", " off "])(
    "refuses when the disable variable is %s",
    async (value) => {
      expect(await refusal({ environmentVariables: { ACME_UPDATE: value } })).toBe("disabled");
    },
  );

  it("still runs when the disable variable is set to anything else", async () => {
    expect((await decide({ environmentVariables: { ACME_UPDATE: "on" } })).kind).toBe("eligible");
  });

  /**
   * A pipeline that pinned a version must still be running it an hour later, so CI and every
   * non-interactive run stay on the binary they selected.
   */
  it.each(["true", "1", "woodpecker"])("refuses when CI is %s", async (value) => {
    expect(await refusal({ environmentVariables: { CI: value } })).toBe("continuous-integration");
  });

  it.each(["stdin", "stdout", "stderr"] as const)(
    "refuses when %s is not a terminal",
    async (stream) => {
      expect(await refusal({ [stream]: plain(stream) })).toBe("not-a-terminal");
    },
  );
});

/** The named refusal, or `undefined` when the gate let the run through. */
async function refusal(
  patch: Partial<EligibilityRequest> = {},
): Promise<EligibilityRefusal | undefined> {
  const verdict = await decide(patch);
  return verdict.kind === "refused" ? verdict.reason : undefined;
}

function current(
  overrides: Partial<Pick<NodeJS.Process, "arch" | "execPath" | "platform">> = {},
): Pick<NodeJS.Process, "arch" | "execPath" | "platform"> {
  return {
    arch: "arm64",
    execPath: executablePath,
    platform: "darwin",
    ...overrides,
  };
}

function terminal(): PassThrough {
  return Object.assign(new PassThrough(), { isTTY: true });
}

function plain(stream: "stderr" | "stdin" | "stdout"): PassThrough | Readable {
  return stream === "stdin" ? Readable.from([]) : new PassThrough();
}

function decide(patch: Partial<EligibilityRequest> = {}): ReturnType<typeof eligibleInstallation> {
  return eligibleInstallation({
    argv: ["check"],
    current: current(),
    disableEnvironmentVariable: "ACME_UPDATE",
    environmentVariables: {},
    stderr: terminal(),
    stdin: terminal(),
    stdout: terminal(),
    version: "1.3.0",
    ...patch,
  });
}
