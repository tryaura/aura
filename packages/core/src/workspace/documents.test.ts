import { describe, expect, it } from "vitest";

import { createDocumentResolver } from "./documents.js";
import { createCachingReader } from "./reader.js";
import { createDocument, createLink, createMemoryReader } from "./testing.js";

describe("createDocumentResolver", () => {
  it("replaces whatever the adapter claimed with what the filesystem says", async () => {
    const reader = createMemoryReader({ "/home/dev/present.md": "# present" });
    const resolver = createDocumentResolver(reader);

    const resolved = await resolver.resolve([
      createDocument("/home/dev/AGENTS.md", [
        createLink("/home/dev/present.md", false),
        createLink("/home/dev/absent.md", true),
      ]),
    ]);

    expect(resolved[0]?.links).toEqual([
      { kind: "import", targetPath: "/home/dev/present.md", valid: true },
      { kind: "import", targetPath: "/home/dev/absent.md", valid: false },
    ]);
  });

  it("probes each target once, however many documents and apps point at it", async () => {
    const reader = createMemoryReader({ "/home/dev/shared.md": "# shared" });
    const resolver = createDocumentResolver(createCachingReader(reader));
    const link = createLink("/home/dev/shared.md");

    await resolver.resolve([
      createDocument("/home/dev/CLAUDE.md", [link]),
      createDocument("/home/dev/AGENTS.md", [link]),
    ]);
    await resolver.resolve([createDocument("/workspace/CLAUDE.md", [link])]);

    expect(reader.probes).toEqual(["/home/dev/shared.md"]);
  });

  it("never opens a target, whatever path an instruction file names", async () => {
    const reader = createMemoryReader({ "/home/dev/.ssh/id_rsa": "PRIVATE KEY" });
    const resolver = createDocumentResolver(reader);

    // What a checked-out repository's CLAUDE.md would import. `~/agents/AGENTS.md` is an ordinary
    // thing to import from a project document, so the path cannot be refused — but existence is
    // all that is ever reported about one, so the bytes are never a reason to open it.
    const resolved = await resolver.resolve([
      createDocument("/workspace/CLAUDE.md", [createLink("/home/dev/.ssh/id_rsa", false)]),
    ]);

    expect(resolved[0]?.links).toEqual([
      { kind: "import", targetPath: "/home/dev/.ssh/id_rsa", valid: true },
    ]);
    expect(reader.reads).toEqual([]);
  });

  it("resolves the documents two applications read through symlinks to one canonical path", async () => {
    const reader = createMemoryReader(
      { "/home/dev/.agents/AGENTS.md": "# shared" },
      {
        links: {
          "/home/dev/.claude/CLAUDE.md": "/home/dev/.agents/AGENTS.md",
          "/home/dev/.codex/AGENTS.md": "/home/dev/.agents/AGENTS.md",
        },
      },
    );
    const resolver = createDocumentResolver(reader);

    const resolved = await resolver.resolve([
      createDocument("/home/dev/.claude/CLAUDE.md"),
      createDocument("/home/dev/.codex/AGENTS.md"),
    ]);

    expect(resolved.map((document) => document.canonicalPath)).toEqual([
      "/home/dev/.agents/AGENTS.md",
      "/home/dev/.agents/AGENTS.md",
    ]);
  });

  it("leaves the canonical path unset for a path that does not resolve", async () => {
    const reader = createMemoryReader();
    const resolver = createDocumentResolver({
      ...reader,
      realPath: () => Promise.resolve(undefined),
    });

    const resolved = await resolver.resolve([createDocument("/home/dev/dangling.md")]);

    expect(resolved[0]).not.toHaveProperty("canonicalPath");
  });

  it("leaves documents without links untouched apart from their canonical path", async () => {
    const document = createDocument("/home/dev/AGENTS.md");
    const resolver = createDocumentResolver(createMemoryReader());

    await expect(resolver.resolve([document])).resolves.toEqual([
      { ...document, canonicalPath: "/home/dev/AGENTS.md" },
    ]);
  });
});
