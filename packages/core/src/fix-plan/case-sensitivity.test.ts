import { rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { detectCaseSensitivity } from "./claims.js";
import { createPathPolicy } from "./path-policy.js";
import { createFixPlanFixture, type FixPlanFixture } from "./testing.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("case sensitivity detection", () => {
  it("answers for the volume the workspace is actually on", async () => {
    const fixture = await createFixture();

    // Which one depends on the runner's filesystem; what must never happen is an undecided answer
    // for a directory that is right there, because both defaults degrade from it.
    expect(["insensitive", "sensitive"]).toContain(await detectCaseSensitivity(fixture.workspace));
  });

  it("reports unknown rather than guessing when the directory is not there", async () => {
    const fixture = await createFixture();

    await expect(detectCaseSensitivity(join(fixture.root, "absent"))).resolves.toBe("unknown");
  });

  it("widens overlap detection but narrows root matching when it cannot decide", async () => {
    const fixture = await createFixture();
    const absent = join(fixture.root, "absent");

    const policy = await createPathPolicy(
      { ...fixture.model, cwd: absent, projectRoot: absent },
      undefined,
    );

    // The two defaults have to disagree. Folding spellings together only ever refuses work, so an
    // undecided probe may do it; matching a path against an allowed root grants a write, so it may
    // not — otherwise `/srv/app` and `/srv/APP` become one root on a volume that keeps them apart.
    expect(policy.caseInsensitive).toBe(true);
    expect(policy.rootsCaseInsensitive).toBe(false);
  });
});

async function createFixture(): Promise<FixPlanFixture> {
  const fixture = await createFixPlanFixture();
  temporaryDirectories.push(fixture.root);
  return fixture;
}
