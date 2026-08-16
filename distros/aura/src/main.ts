#!/usr/bin/env node
import { runCli } from "@tryaura/aura-cli";

import { AURA_DISTRO } from "./distro.js";

await runCli(AURA_DISTRO);
