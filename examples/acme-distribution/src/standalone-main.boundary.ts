#!/usr/bin/env node
import process from "node:process";

import { runStandaloneCli } from "@tryaura/aura-cli";

import { createAcmeDistro } from "./distro.boundary.js";
import { ACME_UPDATES } from "./updates.js";

/**
 * The compiled executable's entry point, and the only one that can update itself.
 *
 * Two entry points rather than one runtime check: only the compiled artifact calls the standalone
 * runner with its process, so package-manager invocations have no updater capability.
 */
await runStandaloneCli(createAcmeDistro(), ACME_UPDATES, process);
