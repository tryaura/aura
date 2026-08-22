import {
  runCli,
  runStandaloneCli,
  type CliDistro,
  type CliRuntime,
  type CliUpdates,
} from "../src/index.js";

declare const current: Pick<NodeJS.Process, "arch" | "execPath" | "platform">;
declare const runtime: CliRuntime;

const distro: CliDistro = {
  branding: { command: "acme", displayName: "Acme" },
  plugins: [],
};

const updates: CliUpdates = {
  kind: "github-release",
  owner: "acme",
  repository: "acme-cli",
};

void runCli(distro, runtime);
void runStandaloneCli(distro, updates, current, runtime);

// @ts-expect-error A package-manager run has no updater parameters.
void runCli(distro, updates, current);

// @ts-expect-error A standalone run must declare the process that owns the executable.
void runStandaloneCli(distro, updates);

// @ts-expect-error A standalone run must declare its update policy.
void runStandaloneCli(distro, undefined, current);

const unsafeUpdates: CliUpdates = {
  kind: "github-release",
  owner: "acme",
  repository: "acme-cli",
  // @ts-expect-error GitHub release immutability cannot be disabled.
  requireImmutable: false,
};
void unsafeUpdates;

// @ts-expect-error Validated candidates are private implementation state.
type PublicCandidate = import("../src/index.js").CliUpdateCandidate;
// @ts-expect-error Validated candidates remain private under their internal name.
type InternalCandidate = import("../src/index.js").UpdateCandidate;
// @ts-expect-error Release targets are private implementation state.
type PublicTarget = import("../src/index.js").CliUpdateTarget;
// @ts-expect-error Release targets remain private under their internal name.
type InternalTarget = import("../src/index.js").UpdateTarget;
// @ts-expect-error Provider variants are represented only by the CliUpdates union.
type PublicSource = import("../src/index.js").CliUpdateSource;
// @ts-expect-error Standalone installation capabilities are no longer public.
type PublicInstallation = import("../src/index.js").CliStandaloneInstallation;
// @ts-expect-error The old standalone process alias is no longer public.
type PublicProcess = import("../src/index.js").StandaloneProcess;

export type PrivateUpdaterTypes =
  | PublicCandidate
  | InternalCandidate
  | PublicTarget
  | InternalTarget
  | PublicSource
  | PublicInstallation
  | PublicProcess;
