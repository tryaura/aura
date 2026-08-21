#!/usr/bin/env node
import process from "node:process";

import { runCli, standaloneInstallation } from "@tryaura/aura-cli";

import { AURA_DISTRO } from "./distro.js";
import { AURA_UPDATES } from "./update/official-source.js";

/**
 * Entry point of the compiled standalone executable, and the only one that can update itself.
 *
 * This file is what `build-binary.mjs` compiles. `main.ts` — the entry the npm package's `bin`
 * points at — declares no installation, so an `npx` or npm-global run cannot reach installation
 * code even though both entry points compose the same distribution.
 *
 * Ownership is read from the process rather than guessed at: `execPath` is the executable the
 * kernel started, and `platform`/`arch` are what it was compiled for. No `npm_execpath` sniffing,
 * no `PATH` walk, no `argv[0]` heuristic — each of which can be made to lie by whoever invoked the
 * process.
 */
const installation = standaloneInstallation({
  architecture: process.arch,
  executablePath: process.execPath,
  platform: process.platform,
});

await runCli(
  { ...AURA_DISTRO, updates: AURA_UPDATES },
  installation === undefined ? {} : { installation },
);
