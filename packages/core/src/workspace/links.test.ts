import { describe, expect, it } from "vitest";

import { createLinkResolver } from "./links.js";
import { createCachingReader } from "./reader.js";
import { createDocument, createLink, createMemoryReader } from "./testing.js";

describe("createLinkResolver", () => {
  it("replaces whatever the adapter claimed with what the filesystem says", async () => {
    const reader = createMemoryReader({ "/home/dev/present.md": "# present" });
    const resolver = createLinkResolver(reader);

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
    const resolver = createLinkResolver(createCachingReader(reader));
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
    const resolver = createLinkResolver(reader);

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

  it("leaves documents without links untouched", async () => {
    const document = createDocument("/home/dev/AGENTS.md");
    const resolver = createLinkResolver(createMemoryReader());

    await expect(resolver.resolve([document])).resolves.toEqual([document]);
  });
});
