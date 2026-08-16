import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPluginRegistry } from "@tryaura/core";

import { findingPlugin } from "../testing.js";
import {
  archiveOriginals,
  backupEntry,
  cleanupFixtures,
  consolidationPlugin,
  createFixture,
  projectConsolidationPlugin,
  snapshot,
} from "./testing.js";
import { runSetup } from "./setup.js";

afterEach(cleanupFixtures);

describe("instruction consolidation setup", () => {
  it("archives a messy home, deduplicates it, wires the app, and converges", async () => {
    const duplicate =
      "Always run the full verification suite before considering implementation complete.";
    const originals = {
      claude: `# Claude\n\n${duplicate}\n\nClaude only.\n`,
      cursor: `# Cursor\n\n${duplicate}\n\nCursor only.\n`,
      windsurf:
        "# Windsurf\n\nKeep the deployment checklist current for every production release.\n",
    };
    const fixture = await createFixture();
    await mkdir(join(fixture.homeDir, ".claude"), { recursive: true });
    await writeFile(join(fixture.homeDir, ".claude", "CLAUDE.md"), originals.claude, "utf8");
    await writeFile(join(fixture.homeDir, ".cursorrules"), originals.cursor, "utf8");
    await writeFile(join(fixture.homeDir, ".windsurfrules"), originals.windsurf, "utf8");
    const registry = createPluginRegistry([consolidationPlugin()], {
      bareCheckIdPlugins: ["checks-core"],
    });

    await expect(runSetup(fixture.request(registry, archiveOriginals()))).resolves.toBe(0);

    const shared = await readFile(join(fixture.homeDir, "agents", "AGENTS.md"), "utf8");
    expect(shared).toContain("# Instructions from ~/.claude/CLAUDE.md");
    expect(shared).toContain("# Instructions from ~/.cursorrules");
    expect(shared).toContain("# Instructions from ~/.windsurfrules");
    expect(shared).not.toContain(fixture.homeDir);
    expect(shared.match(new RegExp(duplicate, "gu"))).toHaveLength(1);
    const entry = await backupEntry(fixture.homeDir);
    await expect(
      readFile(join(entry, "consolidation", "home", ".claude", "CLAUDE.md"), "utf8"),
    ).resolves.toBe(originals.claude);
    await expect(
      readFile(join(entry, "consolidation", "home", ".cursorrules"), "utf8"),
    ).resolves.toBe(originals.cursor);
    await expect(
      readFile(join(fixture.homeDir, ".claude", "CLAUDE.md"), "utf8"),
    ).resolves.toContain("@~/agents/AGENTS.md");
    await expect(lstat(join(fixture.homeDir, ".cursorrules"))).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );

    const before = await snapshot(fixture.homeDir);
    await expect(runSetup(fixture.request(registry, archiveOriginals()))).resolves.toBe(0);
    await expect(snapshot(fixture.homeDir)).resolves.toEqual(before);
  });

  it("converges on the default answers, which leave every original in place", async () => {
    const duplicate = "Always run the full verification suite before considering work complete.";
    const fixture = await createFixture();
    await mkdir(join(fixture.homeDir, ".claude"), { recursive: true });
    await writeFile(
      join(fixture.homeDir, ".claude", "CLAUDE.md"),
      `# Claude\n\n${duplicate}\n`,
      "utf8",
    );
    await writeFile(join(fixture.homeDir, ".cursorrules"), `# Cursor\n\n${duplicate}\n`, "utf8");
    const registry = createPluginRegistry([consolidationPlugin()], {
      bareCheckIdPlugins: ["checks-core"],
    });

    // Warnings, not a clean bill: keeping the originals is what leaves the same guidance in two
    // places, and the end-on-green rescan reports that rather than the plan pretending otherwise.
    await expect(runSetup(fixture.request(registry))).resolves.toBe(1);

    // The default answer is additive: the shared file appears, the sources it was built from stay.
    await expect(readFile(join(fixture.homeDir, ".cursorrules"), "utf8")).resolves.toContain(
      "# Cursor",
    );
    const shared = await readFile(join(fixture.homeDir, "agents", "AGENTS.md"), "utf8");
    expect(shared).toContain("# Instructions from ~/.cursorrules");
    expect(shared.match(/# Instructions from/gu)).toHaveLength(2);

    // Re-running must not merge the same sources into the target a second time.
    const before = await snapshot(fixture.homeDir);
    await expect(runSetup(fixture.request(registry))).resolves.toBe(1);
    await expect(snapshot(fixture.homeDir)).resolves.toEqual(before);
  });

  it("moves project guidance into project AGENTS.md and leaves a portable Claude link", async () => {
    const fixture = await createFixture();
    const source = join(fixture.workspace, "CLAUDE.md");
    await writeFile(source, "# Project\n\nUse the repository verification command.\n", "utf8");
    const registry = createPluginRegistry(
      [projectConsolidationPlugin(), findingPlugin("info", [])],
      {},
    );

    await expect(runSetup(fixture.request(registry, archiveOriginals()))).resolves.toBe(0);

    // Repository-relative provenance: this file is committed, so an absolute path would publish
    // the developer's username and resolve to nothing on anyone else's checkout.
    const shared = await readFile(join(fixture.workspace, "AGENTS.md"), "utf8");
    expect(shared).toContain("# Instructions from CLAUDE.md");
    expect(shared).not.toContain(fixture.workspace);
    await expect(readFile(source, "utf8")).resolves.toContain("@./AGENTS.md");
  });
});
