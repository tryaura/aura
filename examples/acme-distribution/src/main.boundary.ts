#!/usr/bin/env node
import { runCli } from "@tryaura/aura-cli";

import { createAcmeDistro } from "./distro.boundary.js";

// The package-manager entry point. It declares no update source and no standalone installation, so
// a run through a package manager cannot replace an executable that package manager owns.
await runCli(createAcmeDistro());
