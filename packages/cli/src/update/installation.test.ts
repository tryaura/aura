import { describe, expect, it } from "vitest";

import { standaloneInstallation } from "./installation.js";

const EXECUTABLE = "/home/dev/.aura/bin/aura";

describe("standalone installation", () => {
  it.each([
    { architecture: "arm64", platform: "darwin" },
    { architecture: "x64", platform: "darwin" },
    { architecture: "arm64", platform: "linux" },
    { architecture: "x64", platform: "linux" },
  ])("declares $platform $architecture", ({ architecture, platform }) => {
    expect(standaloneInstallation({ architecture, executablePath: EXECUTABLE, platform })).toEqual({
      architecture,
      executablePath: EXECUTABLE,
      kind: "standalone",
      platform,
    });
  });

  /**
   * A compiled binary can still be running where no release targets it. Declining here rather than
   * inside the updater keeps the capability honest: it is supplied only when it is true.
   */
  it.each([
    { architecture: "x64", label: "Windows", platform: "win32" },
    { architecture: "ia32", label: "a 32-bit build", platform: "linux" },
    { architecture: "riscv64", label: "an architecture no release targets", platform: "linux" },
    { architecture: "arm64", label: "an unknown platform", platform: "freebsd" },
  ])("declares nothing on $label", ({ architecture, platform }) => {
    expect(
      standaloneInstallation({ architecture, executablePath: EXECUTABLE, platform }),
    ).toBeUndefined();
  });
});
