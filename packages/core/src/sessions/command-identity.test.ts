import { describe, expect, it } from "vitest";

import { callCommandIdentity, shellSubcommand } from "./command-identity.js";

describe("shellSubcommand", () => {
  it("extracts the first bare token for known multi-command executables", () => {
    expect(shellSubcommand("git diff --stat", "git")).toBe("diff");
    expect(shellSubcommand("git --no-pager diff", "git")).toBe("diff");
    expect(shellSubcommand("/usr/bin/npm test", "npm")).toBe("test");
    expect(shellSubcommand("cargo build --release", "cargo")).toBe("build");
  });

  it("treats a runner's script as the subcommand", () => {
    expect(shellSubcommand("pnpm run test:unit", "pnpm")).toBe("test:unit");
    expect(shellSubcommand("pnpm -r test", "pnpm")).toBe("test");
  });

  it("yields nothing for unknown executables, bare commands, and odd tokens", () => {
    expect(shellSubcommand("ls -la", "ls")).toBeUndefined();
    expect(shellSubcommand("git", "git")).toBeUndefined();
    expect(shellSubcommand("git --version", "git")).toBeUndefined();
    expect(shellSubcommand("git ../Weird", "git")).toBeUndefined();
    expect(shellSubcommand(undefined, "git")).toBeUndefined();
  });
});

describe("callCommandIdentity", () => {
  it("names the executable for simple shell calls only", () => {
    expect(callCommandIdentity({ label: "git", subcommand: "diff", tool: "shell" })).toEqual({
      command: "git",
      subcommand: "diff",
      tool: "shell",
    });
    expect(
      callCommandIdentity({ label: "shell batch", subcommand: undefined, tool: "shell" }),
    ).toEqual({ command: "shell batch", subcommand: undefined, tool: "shell" });
    expect(callCommandIdentity({ label: "shell", subcommand: undefined, tool: "shell" })).toEqual({
      command: undefined,
      subcommand: undefined,
      tool: "shell",
    });
    expect(
      callCommandIdentity({
        label: "mcp:linear.get_issue",
        subcommand: undefined,
        tool: "mcp:linear.get_issue",
      }),
    ).toEqual({ command: undefined, subcommand: undefined, tool: "mcp:linear.get_issue" });
  });
});
