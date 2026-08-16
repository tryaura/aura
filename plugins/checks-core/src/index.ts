import { definePlugin } from "@tryaura/aura-sdk";

import { env001 } from "./env-001.js";
import { env002 } from "./env-002.js";
import { env003 } from "./env-003.js";
import { env004 } from "./env-004.js";
import { sharedInstructionLinksCheck, sharedInstructionsCheck } from "./instructions.js";

export default definePlugin({
  apiVersion: 1,
  checks: [env001, env002, env003, env004, sharedInstructionsCheck, sharedInstructionLinksCheck],
  id: "checks-core",
  name: "Aura Core Checks",
  version: "0.0.0",
});
