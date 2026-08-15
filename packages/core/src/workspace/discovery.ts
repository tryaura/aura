import type {
  Adapter,
  AdapterDetection,
  AdapterFileMap,
  AdapterFileSpec,
  AdapterSourceFile,
  Environment,
} from "@tryaura/aura-sdk";

import type { ScanDiagnostic } from "./diagnostics.js";
import type { FileReader } from "./reader.js";
import { readSpec } from "./specs.js";

/** The most times core asks one adapter to expand its file declarations. */
const MAX_ADAPTER_FILE_ROUNDS = 16;

/** The most paths one adapter may ask core to inspect in a scan. */
const MAX_ADAPTER_FILES = 10_000;

/** Everything {@link discoverAdapterFiles} needs beyond the adapter itself. */
export interface DiscoveryOptions {
  readonly detection: AdapterDetection;
  readonly environment: Environment;
  /** Canonical directory project-scoped paths must stay inside. */
  readonly projectBoundary: string | undefined;
  readonly reader: FileReader;
}

/** What one adapter's file declarations resolved to, and what went wrong resolving them. */
export interface AdapterFileDiscovery {
  readonly diagnostics: readonly ScanDiagnostic[];
  readonly files: AdapterFileMap;
}

/**
 * Calls an adapter until its file declarations reach a fixed point, reading each spec exactly once.
 *
 * A fresh map snapshot is passed on every call so a plugin cannot mutate core's accumulated state.
 * Adapters may return their complete declaration set or only newly discovered specs. Repeated ids
 * must describe the same slot; declaration order is the order retained in the resulting map.
 *
 * Throws on a malformed declaration set or an adapter that never stops finding new paths. Callers
 * turn that into a `files` diagnostic: an adapter that cannot say what it wants read contributes
 * nothing, rather than half a scan.
 */
export async function discoverAdapterFiles(
  adapter: Adapter,
  options: DiscoveryOptions,
): Promise<AdapterFileDiscovery> {
  const { detection, environment, projectBoundary, reader } = options;
  const diagnostics: ScanDiagnostic[] = [];
  const files = new Map<string, AdapterSourceFile>();
  const specs = new Map<string, AdapterFileSpec>();

  for (let round = 0; round < MAX_ADAPTER_FILE_ROUNDS; round += 1) {
    const newSpecs = collectNewSpecs(adapter.files(environment, detection, new Map(files)), specs);

    if (newSpecs.length === 0) {
      return { diagnostics, files };
    }
    if (round === MAX_ADAPTER_FILE_ROUNDS - 1) {
      throw new Error(`file discovery did not stabilize within ${MAX_ADAPTER_FILE_ROUNDS} rounds`);
    }
    if (specs.size + newSpecs.length > MAX_ADAPTER_FILES) {
      throw new Error(`declared more than ${MAX_ADAPTER_FILES} file specs`);
    }

    for (const spec of newSpecs) {
      specs.set(spec.id, spec);
    }

    const reads = await Promise.all(
      newSpecs.map((spec) => readSpec(spec, { adapter, projectBoundary, reader })),
    );
    for (const read of reads) {
      files.set(read.file.spec.id, read.file);
      diagnostics.push(...read.diagnostics);
    }
  }

  throw new Error(`file discovery did not stabilize within ${MAX_ADAPTER_FILE_ROUNDS} rounds`);
}

/** Picks the specs this round introduced, rejecting a declaration set that contradicts itself. */
function collectNewSpecs(
  declared: readonly AdapterFileSpec[],
  known: ReadonlyMap<string, AdapterFileSpec>,
): AdapterFileSpec[] {
  const returnedIds = new Set<string>();
  const newSpecs: AdapterFileSpec[] = [];

  for (const spec of declared) {
    if (returnedIds.has(spec.id)) {
      throw new Error(`declared duplicate file spec id "${spec.id}" in one discovery round`);
    }
    returnedIds.add(spec.id);

    const previous = known.get(spec.id);
    if (previous === undefined) {
      newSpecs.push(spec);
      continue;
    }
    if (!sameSpec(previous, spec)) {
      throw new Error(`redeclared file spec id "${spec.id}" with a different definition`);
    }
  }

  return newSpecs;
}

function sameSpec(left: AdapterFileSpec, right: AdapterFileSpec): boolean {
  return (
    left.id === right.id &&
    left.kind === right.kind &&
    left.optional === right.optional &&
    left.path === right.path &&
    left.scope === right.scope
  );
}
