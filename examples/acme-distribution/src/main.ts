#!/usr/bin/env node
import { runCli, type CliDistro } from "@tryaura/aura-cli";
import { OFFICIAL_PLUGINS, OFFICIAL_REGISTRY_OPTIONS } from "@tryaura/aura-cli/plugins";

import internalPlugin from "./plugin.js";

const distro: CliDistro = {
  branding: {
    command: "acmedev",
    description: "Acme's agent configuration doctor",
    displayName: "Acme Dev",
    docsUrl: "https://engineering.acme.example/acmedev",
    version: "0.1.0",
  },
  plugins: [...OFFICIAL_PLUGINS, internalPlugin],
  registry: OFFICIAL_REGISTRY_OPTIONS,
};

await runCli(distro);
