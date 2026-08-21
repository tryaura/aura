import { describe, expect, it } from "vitest";

import { isInstallableVersion, isNewerVersion } from "./target.js";

describe("release version comparison", () => {
  it.each(["1.4.0", "0.0.1", "1.4.0-rc.1"])("installs %s", (version) => {
    expect(isInstallableVersion(version)).toBe(true);
  });

  it.each([
    { label: "an unstamped source build", version: "0.0.0" },
    { label: "a v-prefixed tag", version: "v1.4.0" },
    { label: "a partial version", version: "1.4" },
    { label: "a range", version: ">=1.4.0" },
    { label: "text", version: "latest" },
    // semver drops build metadata, so `1.4.0+build.5` and `1.4.0` compare equal. A tag that names
    // a release the updater cannot tell apart from another one is not a release it can select.
    { label: "a version carrying build metadata", version: "1.4.0+build.5" },
    { label: "nothing", version: "" },
  ])("refuses $label", ({ version }) => {
    expect(isInstallableVersion(version)).toBe(false);
  });

  it.each([
    { candidate: "1.4.0", current: "1.3.9", newer: true },
    { candidate: "1.4.0", current: "1.4.0", newer: false },
    { candidate: "1.3.9", current: "1.4.0", newer: false },
    { candidate: "1.4.0", current: "1.4.0-rc.1", newer: true },
    { candidate: "1.4.0-rc.1", current: "1.4.0", newer: false },
    { candidate: "1.4.0-rc.2", current: "1.4.0-rc.1", newer: true },
    { candidate: "1.10.0", current: "1.9.0", newer: true },
    { candidate: "1.4.0", current: "not-a-version", newer: false },
  ])("reports $candidate over $current as newer=$newer", ({ candidate, current, newer }) => {
    expect(isNewerVersion(candidate, current)).toBe(newer);
  });
});
