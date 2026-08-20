import type { Check, Environment } from "@tryaura/aura-sdk";
import type { PathDisplayRoots } from "@tryaura/core/display-path";

import type { Style } from "./style.js";

export interface HumanCheckRenderOptions {
  /** The checks the run selected, so a finding can be traced back to its group presentation. */
  readonly checks: readonly Check[];
  readonly colorDepth: number;
  /** Configuration state the run resolved but did not act on, such as a held repository preset. */
  readonly notes: readonly string[];
  readonly roots: PathDisplayRoots;
  readonly verbose: boolean;
}

export interface HumanRenderContext {
  /** The width the report lays out against, taken from the stream it is being written to. */
  readonly columns: number;
  readonly options: HumanCheckRenderOptions;
  readonly style: Style;
}

/** The roots location lines are shortened against, from the run's own environment and scan. */
export function pathDisplayRoots(
  environment: Environment,
  projectRoot: string | undefined,
): PathDisplayRoots {
  return {
    cwd: environment.cwd,
    homeDir: environment.homeDir,
    ...(projectRoot === undefined ? {} : { projectRoot }),
  };
}
