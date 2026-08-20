import { describe, expect, it } from "vitest";

import { listDirectorySkills } from "./directory-client.js";
import {
  LISTING,
  okDirectoryResponse as ok,
  PUBLIC_SOURCE,
  scriptedDirectoryEnvironment as scripted,
} from "./directory-client.test-support.js";

describe("directory listing truncation", () => {
  it("reads a catalog of over a thousand entries completely", async () => {
    const advertised = Array.from({ length: 1_117 }, (_, index) => ({
      ...LISTING,
      id: `skill-${String(index)}`,
    }));
    const { environment } = scripted(() => ok(advertised));

    const result = await listDirectorySkills(environment, PUBLIC_SOURCE, { noCache: true });

    expect(result.listings).toHaveLength(1_117);
    expect(result.truncation).toBeUndefined();
    expect(result.diagnostics).toEqual([]);
  });

  it("reports structured truncation alongside the diagnostic for an oversized index", async () => {
    const advertised = Array.from({ length: 10_117 }, (_, index) => ({
      ...LISTING,
      id: `skill-${String(index)}`,
    }));
    const { environment } = scripted(() => ok(advertised));

    const result = await listDirectorySkills(environment, PUBLIC_SOURCE, { noCache: true });

    expect(result.listings).toHaveLength(10_000);
    expect(result.truncation).toEqual({ advertised: 10_117, read: 10_000 });
    expect(result.diagnostics[0]?.message).toBe(
      'Skill source "directory:agenticskills" index advertises 10117 entries; only the first ' +
        "10000 are read, so some of it is unavailable.",
    );
  });
});
