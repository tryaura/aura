import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT_ROOT = join(ROOT, "apps/web/src/content/docs");
const SIDEBAR = join(ROOT, "apps/web/astro.config.mjs");
const CHECK_SCHEMA = join(ROOT, "packages/cli/schema/check-output-v1.schema.json");

async function documentationFiles() {
  const entries = await readdir(CONTENT_ROOT, { recursive: true });
  return entries
    .filter((entry) => entry.endsWith(".md") || entry.endsWith(".mdx"))
    .map((entry) => join(CONTENT_ROOT, entry))
    .sort();
}

function routeFor(path) {
  const route = relative(CONTENT_ROOT, path).split(sep).join("/").slice(0, -extname(path).length);
  return `/${route}/`;
}

function headings(document) {
  return new Set(
    [...document.matchAll(/^#{2,6}[ \t]+(.+)$/gmu)].map((match) =>
      (match[1] ?? "")
        .toLowerCase()
        .replace(/[`*_]/gu, "")
        .replace(/[^a-z0-9 -]/gu, "")
        .trim()
        .replace(/[ ]+/gu, "-"),
    ),
  );
}

async function readDocuments() {
  const files = await documentationFiles();
  return new Map(
    await Promise.all(files.map(async (path) => [routeFor(path), await readFile(path, "utf8")])),
  );
}

function documentationLinks(document) {
  return [
    ...document.matchAll(/\]\((\/docs\/[^)]+)\)/gu),
    ...document.matchAll(/href="(\/docs\/[^"]+)"/gu),
  ];
}

function expectValidLink(documents, source, target) {
  const [pathname, anchor] = target.split("#", 2);
  const route = `${pathname?.replace(/\/$/u, "")}/`;
  const targetDocument = documents.get(route);
  expect(targetDocument, `${source} links to missing ${target}`).toBeDefined();
  if (anchor !== undefined && anchor !== "") {
    expect(headings(targetDocument ?? ""), `${source} links to missing ${target}`).toContain(
      anchor,
    );
  }
}

function expectValidJsonExamples(path, document) {
  const jsonBlocks = document.matchAll(
    /^[ \t]*```json(?:[ \t]+[^\n]*)?\n([\s\S]*?)^[ \t]*```[ \t]*$/gmu,
  );
  for (const match of jsonBlocks) {
    expect(() => JSON.parse(match[1] ?? ""), `${path} contains invalid JSON`).not.toThrow();
  }
}

function expectTitledFileExamples(path, document) {
  for (const match of document.matchAll(/^[ \t]*```(?:json|ts|js|md)([^\n]*)$/gmu)) {
    expect(match[1], `${path} has an untitled file example`).toContain("title=");
  }
}

describe("public documentation structure", () => {
  it("has searchable frontmatter on every content page", async () => {
    for (const path of await documentationFiles()) {
      const document = await readFile(path, "utf8");
      const frontmatter = /^---\n([\s\S]*?)\n---/u.exec(document)?.[1] ?? "";
      expect(frontmatter, `${path} is missing a title`).toMatch(/^title: .+/mu);
      expect(frontmatter, `${path} is missing a description`).toMatch(/^description: .+/mu);
    }
  });

  it("keeps internal routes and anchors valid", async () => {
    const documents = await readDocuments();

    for (const [source, document] of documents) {
      for (const match of documentationLinks(document)) {
        const target = match[1];
        if (target !== undefined) {
          expectValidLink(documents, source, target);
        }
      }
    }
  });

  it("keeps every sidebar entry on a content route", async () => {
    const routes = new Set((await documentationFiles()).map(routeFor));
    const sidebar = await readFile(SIDEBAR, "utf8");
    for (const match of sidebar.matchAll(/slug: "([^"]+)"/gu)) {
      expect(routes, `sidebar links to missing ${match[1]}`).toContain(`/${match[1]}/`);
    }
  });
});

describe("public documentation examples", () => {
  it("parses every JSON example and titles file examples", async () => {
    for (const path of await documentationFiles()) {
      const document = await readFile(path, "utf8");
      expectValidJsonExamples(path, document);
      expectTitledFileExamples(path, document);
    }
  });

  it("compares report status against a value the contract can emit", async () => {
    // A copyable `jq` gate reads as authoritative even when its literal matches nothing, and no
    // other guard executes the snippet, so the published schema is what the docs are held to.
    const schema = JSON.parse(await readFile(CHECK_SCHEMA, "utf8"));
    const statuses = schema.$defs.report.properties.status.enum;
    expect(statuses, "check schema no longer declares report statuses").toBeInstanceOf(Array);

    for (const path of await documentationFiles()) {
      const document = await readFile(path, "utf8");
      for (const match of document.matchAll(/\.status\s*==\s*"([^"]+)"/gu)) {
        expect(statuses, `${path} compares status against "${match[1]}"`).toContain(match[1]);
      }
    }
  });

  it("does not revive removed routes or obsolete MCP guidance", async () => {
    const documents = await Promise.all(
      (await documentationFiles()).map(async (path) => await readFile(path, "utf8")),
    );
    const content = documents.join("\n");
    expect(content).not.toContain("repository-provided-content");
    expect(content).not.toContain("does not yet provide an MCP picker");
  });
});
