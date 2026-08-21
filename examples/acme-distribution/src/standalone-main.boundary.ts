#!/usr/bin/env node
import process from "node:process";

import { runCli, standaloneInstallation } from "@tryaura/aura-cli";

import { createAcmeDistro } from "./distro.boundary.js";
import { ACME_UPDATES } from "./updates.js";

/**
 * The compiled executable's entry point, and the only one that can update itself.
 *
 * Two entry points rather than one runtime check: ownership of the executable is declared by the
 * artifact that knows it is one, never inferred from `npm_execpath`, `PATH`, or the command name —
 * each of which the invoker controls.
 */
const installation = standaloneInstallation({
  architecture: process.arch,
  executablePath: process.execPath,
  platform: process.platform,
});

await runCli(
  { ...createAcmeDistro(), updates: ACME_UPDATES },
  installation === undefined ? {} : { installation },
);
