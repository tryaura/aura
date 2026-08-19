import type { Writable } from "node:stream";

import { describeFailure } from "@tryaura/core";

import { createOperationalFailureReport, type CheckReport } from "./report.js";

export function renderJson(report: CheckReport, output: Writable): void {
  output.write(`${JSON.stringify(report)}\n`);
}

/**
 * Emits the document a `--json` run still owes the caller when the run itself failed.
 *
 * The failure detail rides along only under `--detail`, mirroring how the human explanation on
 * stderr withholds it: the thrown text may quote a file that holds an API token.
 */
export function renderOperationalFailureJson(
  error: unknown,
  withDetail: boolean,
  output: Writable,
): void {
  renderJson(
    createOperationalFailureReport(
      "check failed unexpectedly. This is a bug in a plugin or the CLI.",
      withDetail ? describeFailure(error) : undefined,
    ),
    output,
  );
}
