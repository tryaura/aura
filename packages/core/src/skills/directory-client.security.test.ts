import { describe, expect, it } from "vitest";

import { createTestEnvironment } from "../workspace/testing.js";
import { listDirectorySkills } from "./directory-client.js";
import { PRIVATE_SOURCE, TOKEN } from "./directory-client.test-support.js";

describe("skill directory connection security", () => {
  it.each([
    "http://skills.example",
    "https://user:secret@skills.example",
    "https://skills.example?redirect=https://attacker.example",
    "https://skills.example#secret",
  ])("refuses an unsafe base URL before reading a token or making a request: %s", async (url) => {
    let variableReads = 0;
    const baseEnvironment = createTestEnvironment();
    const environment = {
      ...baseEnvironment,
      httpGet: () => {
        throw new Error("unexpected request");
      },
      readVariable: () => {
        variableReads += 1;
        return TOKEN;
      },
    };

    const result = await listDirectorySkills(environment, { ...PRIVATE_SOURCE, url });

    expect(result.status.kind).toBe("unavailable");
    expect(variableReads).toBe(0);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("attacker");
  });
});
