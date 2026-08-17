import { describe, expect, it } from "vitest";

import {
  mcpEnvironmentNameProblem,
  mcpServerNameProblem,
  parseMcpServerDefinition,
} from "./mcp-definition.js";
import { parseMcpServerManifest } from "./mcp-server-manifest.js";

const VALID_MANIFEST = {
  credentialEnv: [
    {
      description: "Authenticates requests.",
      name: "GITHUB_TOKEN",
      setupUrl: "https://example.test/token",
    },
  ],
  description: "Search GitHub repositories.",
  docsUrl: "https://example.test/docs",
  id: "official/github",
  name: "GitHub",
  schemaVersion: 1,
  supportedApps: ["claude-code", "cursor"],
  transportTemplate: {
    headers: { Authorization: "Bearer ${GITHUB_TOKEN}" },
    type: "http",
    url: "https://example.test/mcp",
  },
};

describe("MCP server definition validation", () => {
  it("accepts and freezes a credential-safe catalog payload", () => {
    const parsed = parseMcpServerManifest(JSON.stringify(VALID_MANIFEST));

    expect(parsed).toEqual({ value: VALID_MANIFEST });
    if ("error" in parsed) {
      throw new Error("expected a valid MCP server manifest");
    }
    expect(Object.isFrozen(parsed.value)).toBe(true);
    expect(Object.isFrozen(parsed.value.credentialEnv)).toBe(true);
    expect(Object.isFrozen(parsed.value.transportTemplate)).toBe(true);
  });

  it("accepts an environment-only stdio template", () => {
    const parsed = parseMcpServerManifest(
      JSON.stringify({
        ...VALID_MANIFEST,
        credentialEnv: [{ description: "Authenticates requests.", name: "GITHUB_TOKEN" }],
        transportTemplate: {
          args: ["-y", "@modelcontextprotocol/server-github"],
          command: "npx",
          env: ["GITHUB_TOKEN"],
          type: "stdio",
        },
      }),
    );

    expect(parsed).toMatchObject({ value: { transportTemplate: { type: "stdio" } } });
  });

  it.each([
    ["not json", "$", "valid JSON"],
    [{ ...VALID_MANIFEST, schemaVersion: 2 }, "$.schemaVersion", "must be 1"],
    [
      {
        ...VALID_MANIFEST,
        credentialEnv: [{ description: "Token.", name: "TOKEN=value" }],
      },
      "$.credentialEnv[0].name",
      "NAME=value",
    ],
    [
      {
        ...VALID_MANIFEST,
        credentialEnv: [
          { description: "Token.", name: "TOKEN" },
          { description: "Duplicate.", name: "TOKEN" },
        ],
      },
      "$.credentialEnv[1].name",
      "duplicates",
    ],
    [
      {
        ...VALID_MANIFEST,
        transportTemplate: {
          headers: { Authorization: "Bearer ghp_deadbeef ${GITHUB_TOKEN}" },
          type: "http",
          url: "https://example.test/mcp",
        },
      },
      "$.transportTemplate.headers.Authorization",
      "credential literal",
    ],
    [
      {
        ...VALID_MANIFEST,
        transportTemplate: {
          headers: { Authorization: "Bearer ${github_token}" },
          type: "http",
          url: "https://example.test/mcp",
        },
      },
      "$.transportTemplate.headers.Authorization",
      "${VARIABLE}",
    ],
    [
      {
        ...VALID_MANIFEST,
        transportTemplate: { type: "http", url: "file:///tmp/mcp" },
      },
      "$.transportTemplate.url",
      "HTTP(S)",
    ],
    [
      {
        ...VALID_MANIFEST,
        transportTemplate: { command: "mcp", type: "sse" },
      },
      "$.transportTemplate.type",
      "stdio",
    ],
    [
      {
        ...VALID_MANIFEST,
        credentialEnv: [],
      },
      "$.transportTemplate.headers.Authorization",
      "undeclared",
    ],
  ])("rejects malformed payloads at their field path", (value, path, message) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    const parsed = parseMcpServerManifest(text);

    expect(parsed).toMatchObject({ error: { path } });
    if ("value" in parsed) {
      throw new Error("expected an invalid MCP server manifest");
    }
    expect(parsed.error.message).toContain(message);
  });

  it("rejects recognizable credentials in command arguments and URLs", () => {
    expect(
      parseMcpServerDefinition(
        { args: ["--token", "sk-live-secret"], command: "mcp", type: "stdio" },
        "$.transport",
      ),
    ).toMatchObject({ error: { path: "$.transport.args[1]" } });
    expect(
      parseMcpServerDefinition(
        { type: "http", url: "https://example.test/mcp?token=ghp_deadbeef" },
        "$.transport",
      ),
    ).toMatchObject({ error: { path: "$.transport.url" } });
  });

  it("refuses the other transport's fields rather than passing them through unchecked", () => {
    expect(
      parseMcpServerDefinition(
        {
          command: "npx",
          headers: { Authorization: "Bearer ghp_deadbeef" },
          type: "stdio",
        },
        "$.transport",
      ),
    ).toMatchObject({ error: { message: "must not appear on a stdio transport" } });
    expect(
      parseMcpServerDefinition(
        { command: "npx", type: "stdio", url: "https://user:ghp_deadbeef@example.test/mcp" },
        "$.transport",
      ),
    ).toMatchObject({ error: { path: "$.transport.url" } });
    expect(
      parseMcpServerDefinition(
        { env: ["TOKEN=value"], type: "http", url: "https://example.test/mcp" },
        "$.transport",
      ),
    ).toMatchObject({ error: { path: "$.transport.env" } });
  });

  it("keeps unknown transport fields, but only credential-free ones", () => {
    expect(
      parseMcpServerDefinition({ command: "npx", retry: true, type: "stdio" }, "$.transport"),
    ).toEqual({ value: { command: "npx", retry: true, type: "stdio" } });
    expect(
      parseMcpServerDefinition(
        { command: "npx", type: "stdio", vendor: { auth: ["ghp_deadbeef"] } },
        "$.transport",
      ),
    ).toMatchObject({ error: { path: "$.transport.vendor.auth[0]" } });
  });

  it("bounds header framing so a plain-text secret cannot ride along with a reference", () => {
    expect(
      parseMcpServerDefinition(
        {
          headers: { "X-Api-Key": "abcd1234secretvalue ${UNUSED}" },
          type: "http",
          url: "https://example.test/mcp",
        },
        "$.transport",
      ),
    ).toMatchObject({ error: { path: '$.transport.headers["X-Api-Key"]' } });
    expect(
      parseMcpServerDefinition(
        {
          headers: { Authorization: "Bearer ${TOKEN}" },
          type: "http",
          url: "https://example.test/mcp",
        },
        "$.transport",
      ),
    ).toMatchObject({ value: { type: "http" } });
  });

  it("applies the shared name and environment-name rules", () => {
    expect(mcpServerNameProblem("github.search-v1")).toBeUndefined();
    expect(mcpServerNameProblem("bad/name")).toContain("must match");
    expect(mcpServerNameProblem("bad..name")).toContain('".."');
    for (const reserved of ["__proto__", "Prototype", "constructor"]) {
      expect(mcpServerNameProblem(reserved)).toContain("reserved");
    }
    expect(mcpEnvironmentNameProblem("GITHUB_TOKEN")).toBeUndefined();
    expect(mcpEnvironmentNameProblem("github-token")).toContain("must match");
  });
});
