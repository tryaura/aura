#!/usr/bin/env node
import process from "node:process";

import { runStandaloneCli } from "@tryaura/aura-cli";

import { AURA_DISTRO } from "./distro.js";
import { AURA_UPDATES } from "./update/official-source.js";

/**
 * Entry point of the compiled standalone executable, and the only one that can update itself.
 *
 * This file is what `build-binary.mjs` compiles. `main.ts` — the entry the npm package's `bin`
 * points at — calls `runCli`, so an `npx` or npm-global run cannot reach update code even though
 * both entry points compose the same distribution.
 *
 * Passing this process to `runStandaloneCli` declares ownership explicitly. The runner reads
 * `execPath`, `platform`, and `arch`; it never sniffs `npm_execpath`, walks `PATH`, or trusts
 * `argv[0]`.
 */
await runStandaloneCli(AURA_DISTRO, AURA_UPDATES, process);
