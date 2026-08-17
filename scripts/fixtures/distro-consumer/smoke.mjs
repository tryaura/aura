import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { createSeedBuilder, runBinaryCheck } from "@tryaura/aura-testkit";

const seed = await createSeedBuilder().build();

try {
  const result = await runBinaryCheck({
    binaryPath: fileURLToPath(new URL("dist/acmedev", import.meta.url)),
    seed,
  });
  const finding = result.findings.find(({ checkId }) => checkId === "acme/ACME-001");

  assert.equal(
    result.exitCode,
    2,
    JSON.stringify(
      { report: result.report, stderr: result.stderr, stdout: result.stdout },
      null,
      2,
    ),
  );
  assert.equal(finding?.message, "The Acme distribution loaded its private plugin.");
} finally {
  await seed.cleanup();
}
