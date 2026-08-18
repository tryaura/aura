/* eslint-disable max-lines -- one check's precedence scenarios share repository fixtures. */
import type { InstructionDocument } from "@tryaura/aura-sdk";
import { runChecks } from "@tryaura/core";
import { describe, expect, it } from "vitest";

import checksCore from "../index.js";
import { document, model } from "../testing.js";
import { gitignore, projectModel } from "../testing-repository.js";
import { instructionPrecedenceCheck } from "./index.js";

const DUPLICATED_GUIDANCE =
  "Always run the complete verification suite before merging changes because every package must remain healthy.";

describe("INS-008", () => {
  it("is registered as a report-only project warning", () => {
    expect(checksCore.checks).toContain(instructionPrecedenceCheck);
    expect(instructionPrecedenceCheck).toMatchObject({
      defaultSeverity: "warn",
      fixability: "manual",
      id: "INS-008",
      scope: "project",
    });
  });

  it("stays silent outside a repository", () => {
    expect(
      runChecks(
        [instructionPrecedenceCheck],
        model({
          instructionFiles: [
            document("/home/dev/AGENTS.md", DUPLICATED_GUIDANCE),
            document("/workspace/AGENTS.md", DUPLICATED_GUIDANCE, { scope: "project" }),
          ],
        }),
      ).findings,
    ).toEqual([]);
  });

  it("reports exact guidance duplicated from global into project scope", () => {
    const findings = run([
      document("/home/dev/AGENTS.md", DUPLICATED_GUIDANCE),
      document("/repo/AGENTS.md", DUPLICATED_GUIDANCE, { scope: "project" }),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      checkId: "INS-008",
      id: expect.stringMatching(/^duplicate:[0-9a-f]{16}$/u),
      locations: [
        { line: 1, path: "/home/dev/AGENTS.md" },
        { line: 1, path: "/repo/AGENTS.md" },
      ],
      message: "Project instructions repeat guidance from global instructions.",
      metadata: { kind: "duplicate" },
      severity: "warn",
    });
    expect(JSON.stringify(findings)).not.toContain("complete verification suite");
  });

  it("ignores exact duplication confined to one scope", () => {
    expect(
      run([
        document("/repo/AGENTS.md", DUPLICATED_GUIDANCE, { scope: "project" }),
        document("/repo/CLAUDE.md", DUPLICATED_GUIDANCE, { scope: "project" }),
      ]),
    ).toEqual([]);
    expect(
      run([
        document("/home/dev/AGENTS.md", DUPLICATED_GUIDANCE),
        document("/home/dev/CLAUDE.md", DUPLICATED_GUIDANCE),
      ]),
    ).toEqual([]);
  });

  it("reports contradictions only when they cross the global/project boundary", () => {
    const crossScope = run([
      document("/home/dev/AGENTS.md", "Always use tabs for indentation."),
      document("/repo/AGENTS.md", "Always use 2 spaces for indentation.", {
        scope: "project",
      }),
    ]);
    const projectOnly = run([
      document("/repo/AGENTS.md", "Always use tabs for indentation.", { scope: "project" }),
      document("/repo/CLAUDE.md", "Always use 2 spaces for indentation.", {
        scope: "project",
      }),
    ]);

    expect(crossScope).toHaveLength(1);
    expect(crossScope[0]).toMatchObject({
      id: expect.stringMatching(/^contradiction:[0-9a-f]{16}$/u),
      metadata: { axis: "indentation", kind: "contradiction" },
      message: "Project instructions contradict global guidance.",
    });
    expect(projectOnly).toEqual([]);
  });

  it("groups path, package, and custom script signals without exposing their values", () => {
    const content = [
      "Edit packages/core/src/index.ts when changing the kernel.",
      "The @tryaura/core package owns workspace construction.",
      "Run pnpm verify before submitting the change.",
    ].join("\n");
    const findings = run([document("/home/dev/AGENTS.md", content)], {
      packageManifests: [
        {
          name: "@tryaura/core",
          path: "packages/core/package.json",
          scripts: ["build", "test", "verify"],
        },
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      id: expect.stringMatching(/^project-specific:[0-9a-f]{16}$/u),
      locations: [
        { line: 1, path: "/home/dev/AGENTS.md" },
        { line: 2, path: "/home/dev/AGENTS.md" },
        { line: 3, path: "/home/dev/AGENTS.md" },
      ],
      metadata: {
        kind: "project-specific",
        signals: [
          { kind: "path", line: 1 },
          { kind: "package", line: 2 },
          { kind: "script", line: 3 },
        ],
      },
      severity: "warn",
    });
    expect(JSON.stringify(findings)).not.toContain("@tryaura/core");
    expect(JSON.stringify(findings)).not.toContain("pnpm verify");
  });

  it("ignores repository vocabulary shown inside inline and fenced code", () => {
    const content = [
      "Example layout:",
      "",
      "```",
      "packages/core/src/index.ts",
      "```",
      "",
      "Run `pnpm verify` the way `@tryaura/core` documents.",
    ].join("\n");

    expect(
      run([document("/home/dev/AGENTS.md", content)], {
        packageManifests: [
          { name: "@tryaura/core", path: "packages/core/package.json", scripts: ["verify"] },
        ],
      }),
    ).toEqual([]);
  });

  it("grounds path signals in the repository's actual package directories", () => {
    const findings = run(
      [
        document(
          "/home/dev/AGENTS.md",
          [
            "Edit packages/core/src/index.ts when changing the kernel.",
            "Edit services/api/src/index.ts when changing the API.",
            "Edit libs/shared/src/index.ts when changing shared code.",
          ].join("\n"),
        ),
      ],
      {
        packageManifests: [
          { path: "packages/core/package.json", scripts: [] },
          { path: "services/api/package.json", scripts: [] },
          { path: "libs/shared/package.json", scripts: [] },
        ],
      },
    );

    expect(findings).toMatchObject([
      {
        metadata: {
          signals: [
            { kind: "path", line: 1 },
            { kind: "path", line: 2 },
            { kind: "path", line: 3 },
          ],
        },
        severity: "warn",
      },
    ]);

    expect(
      run([document("/home/dev/AGENTS.md", "Use packages/example/src/index.ts for helpers.")], {
        packageManifests: [{ path: "services/api/package.json", scripts: [] }],
      }),
    ).toEqual([]);
  });

  it("ignores bare package names ordinary prose can contain", () => {
    expect(
      run([document("/home/dev/AGENTS.md", "Keep the aura around you calm.")], {
        packageManifests: [{ name: "aura", path: "package.json", scripts: [] }],
      }),
    ).toEqual([]);
  });

  it("reports a lone heuristic signal below the check's default severity", () => {
    const findings = run(
      [
        document(
          "/home/dev/AGENTS.md",
          "Edit packages/core/src/index.ts when changing the kernel.",
        ),
      ],
      { packageManifests: [{ path: "packages/core/package.json", scripts: [] }] },
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ metadata: { kind: "project-specific" }, severity: "info" });
  });

  it("does not treat ubiquitous package scripts as repository-specific", () => {
    const findings = run(
      [document("/home/dev/AGENTS.md", "Always run pnpm test before merging.")],
      {
        packageManifests: [
          { name: "workspace", path: "package.json", scripts: ["build", "test", "typecheck"] },
        ],
      },
    );

    expect(findings).toEqual([]);
  });

  it("recognizes sentence-final custom scripts without matching longer names", () => {
    const manifests = [{ path: "package.json", scripts: ["verify"] }];

    expect(
      run([document("/home/dev/AGENTS.md", "Always run pnpm verify.")], {
        packageManifests: manifests,
      }),
    ).toMatchObject([{ metadata: { signals: [{ kind: "script", line: 1 }] }, severity: "info" }]);
    expect(
      run([document("/home/dev/AGENTS.md", "Always run pnpm verify-all.")], {
        packageManifests: manifests,
      }),
    ).toEqual([]);
    expect(
      run([document("/home/dev/AGENTS.md", "Always run pnpm verify:ci before pushing.")], {
        packageManifests: manifests,
      }),
    ).toEqual([]);
  });

  it("recognizes a namespaced script this repository actually declares", () => {
    expect(
      run([document("/home/dev/AGENTS.md", "Always run pnpm verify:ci before pushing.")], {
        packageManifests: [{ path: "package.json", scripts: ["verify:ci"] }],
      }),
    ).toMatchObject([{ metadata: { signals: [{ kind: "script", line: 1 }] }, severity: "info" }]);
  });

  it("ignores cross-scope duplicates when either paragraph is conditional", () => {
    const project = document("/repo/AGENTS.md", DUPLICATED_GUIDANCE, { scope: "project" });
    const explicit = document("/home/dev/.cursor/rules/explicit.mdc", DUPLICATED_GUIDANCE, {
      metadata: { alwaysApply: false },
    });
    const implicit = document("/home/dev/.cursor/rules/implicit.mdc", DUPLICATED_GUIDANCE);

    expect(run([explicit, project])).toEqual([]);
    expect(run([implicit, project])).toEqual([]);
  });

  it("bounds signal evidence and records the omitted total", () => {
    const content = Array.from(
      { length: 105 },
      (_value, index) => `Edit services/api/src/file-${String(index)}.ts when changing the API.`,
    ).join("\n");
    const findings = run([document("/home/dev/AGENTS.md", content)], {
      packageManifests: [{ path: "services/api/package.json", scripts: [] }],
    });

    expect(findings).toMatchObject([
      {
        metadata: { omittedSignals: 5 },
        severity: "warn",
      },
    ]);
    expect(findings[0]?.locations).toHaveLength(100);
    expect(findings[0]?.metadata?.["signals"]).toHaveLength(100);
    expect(findings[0]?.details).toContain("5 further signals are not listed");
  });

  it("handles repositories whose package manifest inventory is unavailable", () => {
    expect(
      run(
        [
          document(
            "/home/dev/AGENTS.md",
            "Edit services/api/src/index.ts and always run pnpm verify.",
          ),
        ],
        { packageManifestsAbsent: true },
      ),
    ).toEqual([]);
  });

  it("keeps finding identifiers stable when evidence moves within the same files", () => {
    const before = run([
      document("/home/dev/AGENTS.md", "Always use tabs for indentation."),
      document("/repo/AGENTS.md", "Always use 2 spaces for indentation.", {
        scope: "project",
      }),
    ]);
    const after = run([
      document("/home/dev/AGENTS.md", "Heading\nAlways use tabs for indentation."),
      document("/repo/AGENTS.md", "Heading\nAlways use 2 spaces for indentation.", {
        scope: "project",
      }),
    ]);

    expect(before[0]?.id).toBe(after[0]?.id);
  });
});

function run(
  instructionFiles: readonly InstructionDocument[],
  options: {
    readonly packageManifests?: readonly {
      readonly name?: string;
      readonly path: string;
      readonly scripts: readonly string[];
    }[];
    readonly packageManifestsAbsent?: boolean;
  } = {},
) {
  const rootGitignore = gitignore("");
  const workspace = projectModel(rootGitignore, {
    instructionFiles,
    ...(options.packageManifests === undefined
      ? {}
      : { packageManifests: options.packageManifests }),
  });
  const checked = options.packageManifestsAbsent
    ? { ...workspace, repository: { gitignore: rootGitignore } }
    : workspace;
  return runChecks([instructionPrecedenceCheck], checked).findings;
}
