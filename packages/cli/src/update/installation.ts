import type { CliStandaloneInstallation } from "./types.js";

/** The three ambient values a compiled entry point reads about itself. */
export interface StandaloneProcess {
  /** `process.arch`. */
  readonly architecture: string;
  /** `process.execPath` — the executable the kernel started, not `argv[0]`. */
  readonly executablePath: string;
  /** `process.platform`. */
  readonly platform: string;
}

/**
 * Narrows a compiled entry point's own process into a {@link CliStandaloneInstallation}.
 *
 * A distribution still has to call this from a real process boundary and hand over the three
 * values, so ownership stays declared rather than inferred — nothing here goes looking for
 * `npm_execpath`, walks `PATH`, or reads `argv[0]`, each of which the invoker controls.
 *
 * `undefined` when no release targets this machine: a binary compiled for Windows, or for an
 * architecture added after this version. Declining here rather than inside the updater keeps the
 * capability honest, because it is only supplied when it is true.
 */
export function standaloneInstallation(
  current: StandaloneProcess,
): CliStandaloneInstallation | undefined {
  const platform = supportedPlatform(current.platform);
  const architecture = supportedArchitecture(current.architecture);
  if (platform === undefined || architecture === undefined) {
    return undefined;
  }
  return { architecture, executablePath: current.executablePath, kind: "standalone", platform };
}

function supportedPlatform(value: string): CliStandaloneInstallation["platform"] | undefined {
  return value === "darwin" || value === "linux" ? value : undefined;
}

function supportedArchitecture(
  value: string,
): CliStandaloneInstallation["architecture"] | undefined {
  return value === "arm64" || value === "x64" ? value : undefined;
}
