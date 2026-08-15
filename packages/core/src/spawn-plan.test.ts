import { describe, expect, it } from "vitest";

import { planSpawn } from "./spawn-plan.js";

describe("planSpawn", () => {
  it("passes ordinary commands through untouched", () => {
    expect(planSpawn("/usr/local/bin/cursor", ["--version"], "linux")).toEqual({
      args: ["--version"],
      command: "/usr/local/bin/cursor",
      windowsVerbatimArguments: false,
    });
    expect(planSpawn("C:\\bin\\claude.exe", ["--version"], "win32")).toEqual({
      args: ["--version"],
      command: "C:\\bin\\claude.exe",
      windowsVerbatimArguments: false,
    });
  });

  it("leaves a script name alone off Windows", () => {
    expect(planSpawn("/opt/tool/run.cmd", [], "linux")).toEqual({
      args: [],
      command: "/opt/tool/run.cmd",
      windowsVerbatimArguments: false,
    });
  });

  it("routes Windows shell scripts through cmd.exe with an escaped line", () => {
    const path =
      "C:\\Users\\dev\\AppData\\Local\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd";

    expect(planSpawn(path, ["--version"], "win32")).toEqual({
      args: ["/d", "/s", "/c", `"${path} ^"--version^""`],
      command: "cmd.exe",
      windowsVerbatimArguments: true,
    });
  });

  it("escapes spaces in the script path and quotes in arguments", () => {
    const plan = planSpawn("C:\\Program Files\\Tool\\tool.CMD", ['say "hi"', "a&b"], "win32");

    expect(plan.command).toBe("cmd.exe");
    expect(plan.args).toEqual([
      "/d",
      "/s",
      "/c",
      '"C:\\Program^ Files\\Tool\\tool.CMD ^"say^ \\^"hi\\^"^" ^"a^&b^""',
    ]);
  });
});
