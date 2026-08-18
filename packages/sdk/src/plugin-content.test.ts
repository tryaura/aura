import { describe, expect, it } from "vitest";

import { pluginContentUrl } from "./plugin-content.js";

describe("pluginContentUrl", () => {
  it("resolves content beside src during development", () => {
    expect(pluginContentUrl("file:///work/acmedev/src/plugin.js", "snippets/engineering.md")).toBe(
      "file:///work/acmedev/content/snippets/engineering.md",
    );
  });

  it("resolves content beside the module inside a compiled executable", () => {
    expect(pluginContentUrl("file:///$bunfs/root/plugin.js", "snippets/engineering.md")).toBe(
      "file:///$bunfs/root/content/snippets/engineering.md",
    );
  });

  it("keeps the trailing slash a directory source needs", () => {
    expect(pluginContentUrl("file:///$bunfs/root/main.js", "skills/acme-release/")).toBe(
      "file:///$bunfs/root/content/skills/acme-release/",
    );
  });
});
