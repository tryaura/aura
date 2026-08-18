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
import { managedBlockHashCheck } from "./mgd-001.js";
import { mcp001 } from "./mcp-001.js";
import { mcp002 } from "./mcp-002.js";
import { mcp003 } from "./mcp-003.js";
import { skl001 } from "./skl-001.js";
import { skl002 } from "./skl-002.js";
import { skl003 } from "./skl-003.js";
import { skl004 } from "./skl-004.js";

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
    managedBlockHashCheck,
    mcp001,
    mcp002,
    mcp003,
    skl001,
    skl002,
    skl003,
    skl004,
  ],
  id: "checks-core",
  name: "Aura Core Checks",
  version: "0.0.0",
});
