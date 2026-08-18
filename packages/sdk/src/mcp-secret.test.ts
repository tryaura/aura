import { describe, expect, it } from "vitest";

import { isMcpSecretValue } from "./mcp-secret-heuristics.js";
import { inspectJsonMcpSecrets } from "./mcp-secret-inspect.js";
import { isMcpCredentialLiteral } from "./mcp.js";

const CONTEXT = {
  appId: "fixture",
  recordPath: ["mcpServers"],
  scope: "global",
  serverName: "docs-api",
  sourceId: "fixture.mcp",
  variablePattern: /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu,
} as const;

const ENTROPY_SECRET = "aB3dE5fG7hJ9kL2mN4pQ6rS8tV0wXyZ1";

describe("MCP inline secret inspection", () => {
  it("finds every supported field shape without retaining the value", () => {
    const sentinel = "sk-aura-permanent-sentinel-value";
    const sightings = inspectJsonMcpSecrets(
      {
        args: [
          "--token",
          sentinel,
          `--api-key=${sentinel}`,
          `Authorization: Bearer ${sentinel}`,
          sentinel,
        ],
        env: { API_TOKEN: sentinel },
        headers: { Authorization: `Bearer ${sentinel}` },
        url: `https://user:${sentinel}@example.com/${ENTROPY_SECRET}/mcp?api_key=${sentinel}`,
      },
      CONTEXT,
    );

    expect(sightings.map((sighting) => sighting.field)).toEqual([
      "env.API_TOKEN",
      "args[1]",
      "args[2]",
      "args[3]",
      "args[4]",
      "url.username",
      "url.password",
      "url.query.api_key",
      "url.path[1]",
      "headers.Authorization",
    ]);
    expect(sightings[0]?.suggestedEnvName).toBe("API_TOKEN");
    expect(JSON.stringify(sightings)).not.toContain(sentinel);
    expect(JSON.stringify(sightings)).not.toContain(String(sentinel.length));
  });

  it("excludes references, UUIDs, Git SHAs, ordinary values, and low entropy strings", () => {
    const sightings = inspectJsonMcpSecrets(
      {
        args: [
          "${ARG_TOKEN}",
          "123e4567-e89b-42d3-a456-426614174000",
          "0123456789abcdef0123456789abcdef01234567",
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ],
        env: { REGION: "us-east-1", TOKEN: "${TOKEN}" },
        headers: { Accept: "application/json", Authorization: "Bearer ${AUTH_TOKEN}" },
        url: "https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/mcp?region=us-east-1&token=${URL_TOKEN}",
      },
      CONTEXT,
    );

    expect(sightings).toEqual([]);
  });

  it("uses entropy only for long, diverse bare strings", () => {
    expect(isMcpSecretValue(ENTROPY_SECRET)).toBe(true);
    expect(isMcpSecretValue("short-A1b2C3d4")).toBe(false);
    expect(isMcpSecretValue("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
  });

  /*
   * Hexadecimal cannot carry more than 4 bits per character, so any fixed threshold at 4 makes
   * every hex-encoded key unreachable however random it is. The threshold scales to the alphabet
   * the value actually uses, which is what separates a 32-character key from 32 characters of prose.
   */
  it("recognizes hex-encoded keys without flagging prose of the same length", () => {
    expect(isMcpSecretValue("a1b2c3d4e5f60718293a4b5c6d7e8f90")).toBe(true);
    expect(isMcpSecretValue("thisisaveryboringconfigurationvalue")).toBe(false);
    expect(isMcpSecretValue("/Users/dev/projects/example-service/config")).toBe(false);
  });

  /*
   * Detection and validation want opposite mistakes. A high-entropy tenant id in a URL is worth a
   * `[redacted]` in a preview and is not worth rejecting a manifest over, so only the vendor-prefix
   * test gates {@link isMcpCredentialLiteral}.
   */
  it("keeps manifest validation on vendor prefixes rather than entropy", () => {
    expect(isMcpCredentialLiteral("https://example.com/mcp/sk-live-abcdef")).toBe(true);
    expect(isMcpCredentialLiteral(`https://example.com/${ENTROPY_SECRET}/mcp`)).toBe(false);
    expect(isMcpSecretValue(ENTROPY_SECRET)).toBe(true);
  });

  it("adds deterministic safe-field hashes when generated names collide", () => {
    const sightings = inspectJsonMcpSecrets(
      { headers: { "api-key": "one", api_key: "two" } },
      CONTEXT,
    );

    expect(sightings.map((sighting) => sighting.suggestedEnvName)).toEqual([
      expect.stringMatching(/^DOCS_API_HEADERS_API_KEY_[0-9A-F]{8}$/u),
      expect.stringMatching(/^DOCS_API_HEADERS_API_KEY_[0-9A-F]{8}$/u),
    ]);
    expect(sightings[0]?.suggestedEnvName).not.toBe(sightings[1]?.suggestedEnvName);
  });
});
