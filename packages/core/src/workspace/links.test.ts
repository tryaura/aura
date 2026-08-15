import { describe, expect, it } from "vitest";

import { createLinkResolver } from "./links.js";
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

  it("reads each target once, however many documents and apps point at it", async () => {
    const reader = createMemoryReader({ "/home/dev/shared.md": "# shared" });
    const resolver = createLinkResolver(reader);
    const link = createLink("/home/dev/shared.md");

    await resolver.resolve([
      createDocument("/home/dev/CLAUDE.md", [link]),
      createDocument("/home/dev/AGENTS.md", [link]),
    ]);
    await resolver.resolve([createDocument("/workspace/CLAUDE.md", [link])]);

    expect(reader.reads).toEqual(["/home/dev/shared.md"]);
  });

  it("leaves documents without links untouched", async () => {
    const document = createDocument("/home/dev/AGENTS.md");
    const resolver = createLinkResolver(createMemoryReader());

    await expect(resolver.resolve([document])).resolves.toEqual([document]);
  });
});
