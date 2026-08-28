import { describe, expect, it } from "vitest";

import { shellIdentityFromCommand } from "./outcome-classify.js";

describe("shellIdentityFromCommand", () => {
  it("keeps privacy-safe command and subcommand identities for shell batches", () => {
    expect(
      shellIdentityFromCommand(
        "pnpm build && pnpm test\n/usr/bin/git status | rg changed packages",
      ),
    ).toEqual({
      batchComponents: [
        { command: "pnpm", subcommand: "build" },
        { command: "pnpm", subcommand: "test" },
        { command: "git", subcommand: "status" },
        { command: "rg", subcommand: undefined },
      ],
      command: "pnpm build && pnpm test\n/usr/bin/git status | rg changed packages",
      label: "shell batch",
    });
  });

  it("never turns quoted text, comments, or nested commands into component identities", () => {
    const identity = shellIdentityFromCommand(
      "printf '%s' 'private; token' && echo \"$(printf 'hidden|value')\" # ignored; secret\npnpm test",
    );

    expect(identity.batchComponents).toEqual([
      { command: "printf", subcommand: undefined },
      { command: "echo", subcommand: undefined },
      { command: "pnpm", subcommand: "test" },
    ]);
  });

  it("suppresses component detail when the batch contains a heredoc", () => {
    const identity = shellIdentityFromCommand("cat <<'EOF'\nprivate\nEOF\npnpm test");

    expect(identity).toMatchObject({ batchComponents: [], label: "shell batch" });
  });
});
