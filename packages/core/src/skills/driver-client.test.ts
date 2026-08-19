import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  DriverSkillListing,
  DriverSkillPack,
  DriverSkillSource,
  SkillSourceDriver,
} from "@tryaura/aura-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createEnvironment } from "../environment.boundary.js";
import type { FileReader } from "../workspace/reader.js";
import { createMemoryReader } from "../workspace/testing.js";
import { MAX_SKILL_DRIVER_CALL_MS, MAX_SKILL_FILE_BYTES } from "./limits.js";
import { listDriverSkills, resolveDriverSkills } from "./driver-client.js";

const roots: string[] = [];
const LISTING: DriverSkillListing = {
  description: "Reviews a change.",
  id: "review",
  name: "Review",
  originUrl: "https://skills.example.com/review",
  version: "1.0.0",
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("driver skill client", () => {
  it("keeps valid listings when another listing and another source fail", async () => {
    const good = source({
      list: vi.fn().mockResolvedValue([LISTING, { ...LISTING, id: "../unsafe" }]),
      resolve: vi.fn().mockResolvedValue(new Map()),
    });
    const failed = source(
      {
        list: vi.fn().mockRejectedValue(new Error("secret raw failure")),
        resolve: vi.fn().mockResolvedValue(new Map()),
      },
      "other/source",
    );

    const [listed, unavailable] = await Promise.all([
      listDriverSkills(environment(), good),
      listDriverSkills(environment(), failed),
    ]);

    expect(listed.listings.map(({ id }) => id)).toEqual(["review"]);
    expect(listed.messages.join(" ")).not.toContain("../unsafe");
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.messages.join(" ")).not.toContain("secret raw failure");
  });

  it("resolves all requested IDs in one call and isolates unsafe packs", async () => {
    const validRoot = await skillDirectory("valid", { "SKILL.md": "# Valid\n" });
    const missingRoot = await skillDirectory("missing", { "README.md": "missing\n" });
    const resolve = vi.fn().mockResolvedValue(
      new Map([
        ["review", pack("review", validRoot)],
        ["missing", pack("missing", missingRoot)],
      ]),
    );
    const driver = source({ list: vi.fn().mockResolvedValue([]), resolve });

    const result = await resolveDriverSkills(environment(), driver, ["review", "missing"]);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]?.[1]).toEqual(["review", "missing"]);
    expect(result.skills.map(({ id }) => id)).toEqual(["review"]);
    expect(result.problems.has("missing")).toBe(true);
  });

  it("refuses a directory carrying a file that is not valid UTF-8", async () => {
    const root = await skillDirectory("binary", {
      "SKILL.md": "# Binary\n",
      "notes.md": Uint8Array.from([0x68, 0x69, 0xff, 0xfe, 0x0a]),
    });
    const driver = source({
      list: vi.fn().mockResolvedValue([]),
      resolve: vi.fn().mockResolvedValue(new Map([["binary", pack("binary", root)]])),
    });

    const result = await resolveDriverSkills(environment(), driver, ["binary"]);

    expect(result.skills).toEqual([]);
    expect(result.problems.has("binary")).toBe(true);
  });

  it("stops waiting on a driver that never settles", async () => {
    vi.useFakeTimers();
    try {
      const driver = source({
        list: vi.fn().mockReturnValue(new Promise(() => undefined)),
        resolve: vi.fn().mockReturnValue(new Promise(() => undefined)),
      });

      const listed = listDriverSkills(environment(), driver);
      const resolved = resolveDriverSkills(environment(), driver, ["review"]);
      await vi.advanceTimersByTimeAsync(MAX_SKILL_DRIVER_CALL_MS);

      expect((await listed).status).toBe("unavailable");
      expect((await resolved).problems.get("review")).toContain("in time");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses portable path aliases and oversized files", async () => {
    const largeRoot = await skillDirectory("large", {
      "SKILL.md": "x".repeat(MAX_SKILL_FILE_BYTES + 1),
    });
    const driver = source({
      list: vi.fn().mockResolvedValue([]),
      resolve: vi.fn().mockResolvedValue(
        new Map([
          ["alias", pack("alias", "/virtual/alias")],
          ["large", pack("large", largeRoot)],
        ]),
      ),
    });

    const alias = await resolveDriverSkills(environment(), driver, ["alias"], aliasReader());
    const result = await resolveDriverSkills(environment(), driver, ["large"]);

    expect(alias.skills).toEqual([]);
    expect(alias.problems.has("alias")).toBe(true);
    expect(result.skills).toEqual([]);
    expect(result.problems.has("large")).toBe(true);
  });
});

function environment() {
  return createEnvironment({ cwd: "/workspace", homeDir: "/home/dev" });
}

function aliasReader(): FileReader {
  return {
    exists: () => Promise.resolve(true),
    read: (path) => {
      if (path === "/virtual/alias") {
        return Promise.resolve({
          entries: ["README.md", "Readme.md", "SKILL.md"],
          exists: true,
          isDirectory: true,
          pathKind: "directory",
        });
      }
      return Promise.resolve({
        content: path.endsWith("SKILL.md") ? "# Alias\n" : "alias\n",
        exists: true,
        isDirectory: false,
        pathKind: "file",
        size: 6,
      });
    },
    readWithin: (path, _directories, options) =>
      createMemoryReader({ [path]: "alias\n" }).readWithin(path, ["/"], options),
    realPath: (path) => Promise.resolve(path),
  };
}

function source(
  methods: Pick<SkillSourceDriver, "list" | "resolve">,
  id = "acme/source",
): DriverSkillSource {
  const driver: SkillSourceDriver = {
    description: "Fixture source.",
    id,
    list: methods.list,
    name: "Acme skills",
    resolve: methods.resolve,
  };
  return { driver, id: `driver:${id}`, kind: "driver", name: "Acme skills" };
}

function pack(id: string, root: string): DriverSkillPack {
  return {
    ...LISTING,
    id,
    kind: "skill-pack",
    originUrl: `https://skills.example.com/${id}`,
    source: { type: "directory", url: pathToFileURL(root).href },
  };
}

async function skillDirectory(
  name: string,
  files: Readonly<Record<string, string | Uint8Array>>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `aura-driver-${name}-`));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}
