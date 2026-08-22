#!/usr/bin/env node
import { runCli } from "@tryaura/aura-cli";

import { createAcmeDistro } from "./distro.boundary.js";

// The package-manager entry point uses the runner with no updater capability, so it cannot replace
// an executable that package manager owns.
await runCli(createAcmeDistro());
