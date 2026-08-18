import { Buffer } from "node:buffer";

import type { WriteFileOperation } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import {
  mcpSecretRedactor,
  rememberWriteRedactor,
  renderRedactedWriteDiff,
} from "./write-redaction.js";

describe("semantic write preview redaction", () => {
  it("masks both sides of a same-path write group", () => {
    const sentinel = "sk-aura-preview-sentinel";
    const first = write(`before=${sentinel}\n`);
    const second = write(`after=${sentinel}\n`);
    for (const operation of [first, second]) {
      rememberWriteRedactor(operation, (content) => content.replaceAll(sentinel, "[redacted]"));
    }

    const diff = renderRedactedWriteDiff(
      [first, second],
      "/home/dev/.config/mcp.json",
      {
        content: Buffer.from(`before=${sentinel}\n`),
        kind: "file",
        mode: 0o600,
        modifiedTimeMs: 0,
        size: 32,
      },
      `after=${sentinel}\n`,
      0o600,
      0o600,
    );

    expect(diff).not.toContain(sentinel);
    expect(diff).toContain("-before=[redacted]");
    expect(diff).toContain("+after=[redacted]");
  });

  it("fails closed to a summary when any semantic projection cannot be applied", () => {
    const operation = write("new secret");
    rememberWriteRedactor(operation, () => undefined);

    const diff = renderRedactedWriteDiff(
      [operation],
      "/home/dev/.config/mcp.json",
      {
        content: Buffer.from("old secret"),
        kind: "file",
        mode: 0o600,
        modifiedTimeMs: 0,
        size: 10,
      },
      operation.content,
      0o600,
      0o600,
    );

    expect(diff).toContain("Sensitive MCP configuration would change.");
    expect(diff).not.toContain("secret");
  });

  it("still renders the created file, which has no previous side to leak from", () => {
    const operation = write(`created=${"sk-aura-create-sentinel"}\n`);
    rememberWriteRedactor(operation, (content) =>
      content.replaceAll("sk-aura-create-sentinel", "[redacted]"),
    );

    const diff = renderRedactedWriteDiff(
      [operation],
      "/home/dev/.config/created.json",
      { kind: "missing" },
      operation.content,
      0o600,
      0o600,
    );

    expect(diff).toContain("+created=[redacted]");
    expect(diff).not.toContain("sk-aura-create-sentinel");
    expect(diff).not.toContain("Sensitive MCP configuration would change.");
  });

  it("fails closed when a masker reports a field the content did not account for", () => {
    const sentinel = "sk-aura-unresolved-sentinel";
    const redact = mcpSecretRedactor(
      {
        redact: ({ content }) => ({ content, unresolved: ["env.DOCS_TOKEN"] }),
        rewrite: () => ({ refusal: "unused" }),
        supports: () => true,
      },
      [],
    );

    expect(redact(`env.DOCS_TOKEN = "${sentinel}"`)).toBeUndefined();
  });

  /*
   * The registry is keyed on the operation object, so a copy made anywhere between planning and
   * preview arrives without its masker. Nothing in the type system prevents that, and the symptom
   * would be a credential in a diff, so the path is remembered too and an unmasked write to it
   * summarizes rather than trusting the absence.
   */
  it("summarizes an unregistered write to a path that has needed masking", () => {
    const registered = write("registered\n");
    rememberWriteRedactor(registered, (content) => content);
    const copy = { ...registered, content: `leaked=${"sk-aura-copy-sentinel"}\n` };

    const diff = renderRedactedWriteDiff(
      [copy],
      copy.path,
      { kind: "missing" },
      copy.content,
      0o600,
      0o600,
    );

    expect(diff).toContain("Sensitive MCP configuration would change.");
    expect(diff).not.toContain("sk-aura-copy-sentinel");
  });
});

function write(content: string): WriteFileOperation {
  return { content, path: "/home/dev/.config/mcp.json", type: "write" };
}
