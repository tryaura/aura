import type { Writable } from "node:stream";

// Deep import on purpose: see the note in run.boundary.ts.
import type { BaseContext } from "clipanion/lib/advanced/index.js";

import type { AuraConfigurationLayer, Environment } from "@tryaura/aura-sdk";
import type { PluginRegistry } from "@tryaura/core";

import type { TelemetryRecorder } from "./telemetry.js";
import type { CliBranding } from "./types.js";

export interface AuraCliContext extends BaseContext {
  readonly branding: CliBranding;
  readonly cwd: string;
  /** Home directory captured at the process boundary, before any `--home` override. */
  readonly defaultHomeDir: string;
  readonly defaultPreset?: string | undefined;
  readonly defaults?: AuraConfigurationLayer | undefined;
  /** Injected network access; absent means the kernel's own bounded client. */
  readonly httpGet?: Environment["httpGet"] | undefined;
  /** The run's clock, injected at the process boundary so commands and telemetry agree on time. */
  readonly now: () => Date;
  readonly registry: PluginRegistry;
  /** Machine-readable output, kept apart from plugin-written `stdout`. */
  readonly report: Writable;
  /** The run's telemetry recorder. A no-op unless the distribution composed a sink. */
  readonly telemetry: TelemetryRecorder;
}
