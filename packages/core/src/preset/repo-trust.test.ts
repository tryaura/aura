import { describe, expect, it } from "vitest";

import { createEnvironment } from "../environment.boundary.js";
import { createEmptyAuraManifest } from "../manifest/codec.js";
import { createMemoryReader } from "../workspace/testing.js";
import { hashRepoPreset, isRepoPresetTrusted, readRepoPreset } from "./repo-trust.js";

const PATH = "/workspace/.aura/preset.json";
const DOCUMENT = '{"schemaVersion":1,"name":"Repo","checks":{"severity":{"INS-007":"error"}}}';

function environment() {
  return createEnvironment({ cwd: "/workspace", homeDir: "/home/dev" });
}

describe("readRepoPreset", () => {
  it("reads, validates, and hashes the repository preset", async () => {
    const state = await readRepoPreset(environment(), createMemoryReader({ [PATH]: DOCUMENT }));

    expect(state).toMatchObject({
      hash: hashRepoPreset(DOCUMENT),
      path: PATH,
      preset: { name: "Repo", schemaVersion: 1 },
      status: "ready",
    });
    expect(state.diagnostics).toEqual([]);
  });

  it("reports a missing file as the ordinary case", async () => {
    const state = await readRepoPreset(environment(), createMemoryReader());

    expect(state).toMatchObject({ path: PATH, status: "missing" });
    expect(state.hash).toBeUndefined();
  });

  it("fails closed with a diagnostic when the file is invalid", async () => {
    const state = await readRepoPreset(environment(), createMemoryReader({ [PATH]: "{ broken" }));

    expect(state.status).toBe("invalid");
    expect(state.preset).toBeUndefined();
    expect(state.diagnostics[0]?.message).toContain("is not valid JSON");
  });
});

describe("hashRepoPreset", () => {
  it("does not change across line-ending rewrites of the same contents", () => {
    expect(hashRepoPreset('{"a":1}\n')).toBe(hashRepoPreset('{"a":1}\r\n'));
    expect(hashRepoPreset('{"a":1}')).not.toBe(hashRepoPreset('{"a":2}'));
  });
});

describe("isRepoPresetTrusted", () => {
  const hash = hashRepoPreset(DOCUMENT);
  const manifest = {
    ...createEmptyAuraManifest(),
    trustedRepoPresets: [{ hash, path: PATH }],
  };

  it("matches only the exact path and contents that were accepted", () => {
    expect(isRepoPresetTrusted(manifest, PATH, hash)).toBe(true);
    expect(isRepoPresetTrusted(manifest, PATH, hashRepoPreset("{}"))).toBe(false);
    expect(isRepoPresetTrusted(manifest, "/elsewhere/.aura/preset.json", hash)).toBe(false);
    expect(isRepoPresetTrusted(undefined, PATH, hash)).toBe(false);
    expect(isRepoPresetTrusted(createEmptyAuraManifest(), PATH, hash)).toBe(false);
  });
});
