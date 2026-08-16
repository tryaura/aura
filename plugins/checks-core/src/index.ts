import { definePlugin } from "@tryaura/aura-sdk";

import { env001 } from "./env-001.js";
import { env002 } from "./env-002.js";
import { env003 } from "./env-003.js";
import { env004 } from "./env-004.js";
import { duplicateInstructionsCheck } from "./ins-003/index.js";
import { legacyInstructionsCheck } from "./ins-004.js";
import { contradictoryInstructionsCheck } from "./ins-005/index.js";
import { instructionLinkIntegrityCheck } from "./ins-006/index.js";
import { instructionContextBudgetCheck } from "./ins-007/index.js";
import { instructionPrecedenceCheck } from "./ins-008/index.js";
import { sharedInstructionLinksCheck, sharedInstructionsCheck } from "./instructions.js";
import { legacyInstructionsAdapter } from "./legacy-adapter.js";

export default definePlugin({
  adapters: [legacyInstructionsAdapter],
  apiVersion: 1,
  checks: [
    env001,
    env002,
    env003,
    env004,
    sharedInstructionsCheck,
    sharedInstructionLinksCheck,
    duplicateInstructionsCheck,
    legacyInstructionsCheck,
    contradictoryInstructionsCheck,
    instructionLinkIntegrityCheck,
    instructionContextBudgetCheck,
    instructionPrecedenceCheck,
  ],
  id: "checks-core",
  name: "Aura Core Checks",
  version: "0.0.0",
});
