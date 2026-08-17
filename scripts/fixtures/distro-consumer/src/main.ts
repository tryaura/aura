#!/usr/bin/env node
import { runCli } from "@tryaura/aura-cli";
import { OFFICIAL_PLUGINS, OFFICIAL_REGISTRY_OPTIONS } from "@tryaura/aura-cli/plugins";

import { acmePlugin } from "./plugin.js";

await runCli({
  branding: {
    command: "acmedev",
    description: "Acme's branded agent configuration doctor",
    displayName: "Acme Dev",
    docsUrl: "https://engineering.acme.example/acmedev",
    version: "0.1.0",
  },
  plugins: [...OFFICIAL_PLUGINS, acmePlugin],
  registry: OFFICIAL_REGISTRY_OPTIONS,
});
