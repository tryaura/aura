import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createSeedBuilder } from "@tryaura/aura-testkit";
import { describe, expect, it } from "vitest";

const BINARY_PATH = fileURLToPath(new URL("../dist/aura", import.meta.url));
const execFileAsync = promisify(execFile);

describe("compiled snippet content", () => {
  it("reads every embedded snippet during setup", async () => {
    await using seed = await createSeedBuilder()
      .workspaceFile(
        ".aura/preset.json",
        '{"schemaVersion":1,"snippets":["official/commit-conventions"]}\n',
      )
      .trustWorkspacePreset()
      .build();

    const result = await execFileAsync(BINARY_PATH, ["setup", "--yes"], {
      cwd: seed.workspaceDir,
      encoding: "utf8",
      env: { HOME: seed.homeDir, NO_COLOR: "1", PATH: seed.pathDir },
    });

    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("Snippet official/commit-conventions is unavailable");
    expect(result.stdout).not.toContain("Snippet official/ask-before-destructive is unavailable");
    expect(result.stdout).not.toContain("Snippet official/pr-descriptions is unavailable");
    expect(result.stdout).not.toContain("Snippet official/jira-linking is unavailable");
    expect(result.stdout).not.toContain("Snippet official/confluence-references is unavailable");
    expect(result.stdout).not.toContain("Snippet official/typescript-style is unavailable");
    expect(result.stdout).not.toContain("Snippet official/python-style is unavailable");
  });
});
