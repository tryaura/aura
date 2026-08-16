import type { AdapterParseInput, ExecRequest } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { buildWorkspaceModel } from "../index.js";
import {
  createMemoryReader,
  createSnapshot,
  createTestAdapter,
  createTestEnvironment,
  DIRECTORY,
} from "./testing.js";

/** Answers the three commands the repository scan runs, in the shapes real Git produces. */
function gitResponse(request: ExecRequest): { exitCode: number; stderr: string; stdout: string } {
  if (request.args?.[0] === "--version") {
    return { exitCode: 0, stderr: "", stdout: "git version 2.50.1\n" };
  }
  if (request.args?.includes("--git-common-dir") === true) {
    return { exitCode: 0, stderr: "", stdout: "/workspace/.git\n" };
  }
  return { exitCode: 0, stderr: "", stdout: "AGENTS.md\0.claude/settings.local.json\0" };
}

describe("repository workspace state", () => {
  it("passes the repository root to adapters and captures the root gitignore once", async () => {
    let received: AdapterParseInput | undefined;
    const requests: ExecRequest[] = [];
    const baseEnvironment = createTestEnvironment({ cwd: "/workspace/packages/core" });
    const environment = {
      ...baseEnvironment,
      exec: (request: ExecRequest) => {
        requests.push(request);
        return Promise.resolve(gitResponse(request));
      },
      pathEntries: ["/tools"],
    };
    const reader = createMemoryReader({
      "/workspace/.git": DIRECTORY,
      "/workspace/.git/info/exclude": "/.claude/settings.local.json\n",
      "/workspace/.gitignore": "# heading\n\n/dist\r\n!/AGENTS.md\n",
      "/workspace/packages/core/.gitignore": "nested file must not be read\n",
    });

    const { model } = await buildWorkspaceModel({
      adapters: [
        createTestAdapter({
          parse: (input) => {
            received = input;
            return createSnapshot();
          },
        }),
      ],
      environment,
      reader,
    });

    expect(received?.projectRoot).toBe("/workspace");
    expect(model.repository).toEqual({
      gitignore: {
        content: "# heading\n\n/dist\r\n!/AGENTS.md\n",
        exists: true,
        path: "/workspace/.gitignore",
        patterns: [
          { line: 3, value: "/dist" },
          { line: 4, value: "!/AGENTS.md" },
        ],
      },
      infoExclude: {
        content: "/.claude/settings.local.json\n",
        exists: true,
        path: "/workspace/.git/info/exclude",
        patterns: [{ line: 1, value: "/.claude/settings.local.json" }],
      },
      trackedAgentPaths: ["AGENTS.md", ".claude/settings.local.json"],
    });
    expect(reader.reads.filter((path) => path === "/workspace/.gitignore")).toHaveLength(1);
    expect(reader.reads).not.toContain("/workspace/packages/core/.gitignore");
    // The whole checkout is never listed: only paths an agent application is known to write.
    expect(requests.map((request) => [request.command, ...(request.args ?? [])])).toEqual([
      ["/tools/git", "--version"],
      ["/tools/git", "-C", "/workspace", "rev-parse", "--path-format=absolute", "--git-common-dir"],
      [
        "/tools/git",
        "-C",
        "/workspace",
        "ls-files",
        "-z",
        "--",
        ".claude/settings.local.json",
        ".cursor/mcp.json",
        ".mcp.json",
        "AGENTS.md",
        "CLAUDE.md",
      ],
    ]);
  });

  it("ignores a relative common directory from a Git too old to honour the path format", async () => {
    const environment = {
      ...createTestEnvironment(),
      exec: (request: ExecRequest) =>
        Promise.resolve(
          request.args?.includes("--git-common-dir") === true
            ? { exitCode: 0, stderr: "", stdout: ".git\n" }
            : gitResponse(request),
        ),
      pathEntries: ["/tools"],
    };

    const { model } = await buildWorkspaceModel({
      adapters: [],
      environment,
      reader: createMemoryReader({ "/workspace/.git": DIRECTORY }),
    });

    expect(model.repository?.infoExclude).toBeUndefined();
    expect(model.repository?.trackedAgentPaths).toEqual([
      "AGENTS.md",
      ".claude/settings.local.json",
    ]);
  });

  it("models missing and unreadable root gitignore files and tolerates unavailable Git", async () => {
    const base = {
      adapters: [],
      environment: createTestEnvironment(),
    };
    const missing = await buildWorkspaceModel({
      ...base,
      reader: createMemoryReader({ "/workspace/.git": DIRECTORY }),
    });
    const unreadable = await buildWorkspaceModel({
      ...base,
      reader: createMemoryReader(
        { "/workspace/.git": DIRECTORY },
        { problems: { "/workspace/.gitignore": "denied" } },
      ),
    });

    expect(missing.model.repository).toEqual({
      gitignore: { exists: false, path: "/workspace/.gitignore", patterns: [] },
    });
    expect(unreadable.model.repository).toEqual({
      gitignore: {
        exists: true,
        path: "/workspace/.gitignore",
        patterns: [],
        problem: "denied",
      },
    });
  });
});
