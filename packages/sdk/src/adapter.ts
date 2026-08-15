import type { JsonObject, Scope } from "./common.js";
import type { Environment } from "./environment.js";
import type { AdapterSnapshot } from "./model.js";

/** What an adapter expects a declared file to contain. */
export type AdapterFileKind = "config" | "instructions" | "mcp" | "skills";

/** A file or directory an adapter asks Aura core to read on its behalf. */
export interface AdapterFileSpec {
  /**
   * Stable identifier for this slot, unique within the adapter.
   *
   * Parsed artifacts carry it forward as `sourceId` so a finding can be traced to the file it
   * came from.
   */
  readonly id: string;
  /** What the adapter expects to find here. */
  readonly kind: AdapterFileKind;
  /** Whether a missing path is normal. A required path that is absent is reported to the user. */
  readonly optional?: boolean | undefined;
  /** Absolute path. Build it from {@link Environment.homeDir} or {@link Environment.cwd}. */
  readonly path: string;
  /** Whether this is user-level or workspace-level state. */
  readonly scope: Scope;
}

/** Whether a declared path was found, without its contents. */
export interface AdapterFileStatus {
  /** Whether the path existed when Aura core read it. */
  readonly exists: boolean;
  /** The spec that requested this path. */
  readonly spec: AdapterFileSpec;
}

/**
 * A declared path together with its contents.
 *
 * Only {@link Adapter.parse} receives these. The normalized model keeps {@link AdapterFileStatus}
 * instead, so raw file contents are not retained alongside the documents parsed out of them.
 */
export interface AdapterSourceFile extends AdapterFileStatus {
  /** File contents, absent when {@link AdapterFileStatus.exists} is `false` or the path is a directory. */
  readonly content?: string | undefined;
}

/** What {@link Adapter.detect} learned about an installed application. */
export interface AdapterDetection {
  /** Whether the application has usable credentials, when the adapter can tell cheaply. */
  readonly authenticated?: boolean | undefined;
  /** Absolute path to the resolved executable. Prefer it over a bare name in later `exec` calls. */
  readonly executablePath?: string | undefined;
  /** Whether the application is installed. When `false`, Aura core skips the adapter. */
  readonly installed: boolean;
  /**
   * Adapter-defined detail surfaced in diagnostics.
   *
   * Rendered in user-visible output. Never place credentials or file contents here.
   */
  readonly metadata?: JsonObject | undefined;
  /** Detected version, when the application reports one. */
  readonly version?: string | undefined;
}

/** Whether Aura understands the detected version of an application. */
export type AdapterSupportStatus = "supported" | "unknown" | "unsupported";

/** The result of comparing a detected version against {@link Adapter.supportedRange}. */
export interface AdapterSupport {
  /** Outcome of the comparison. `unknown` when no version could be detected. */
  readonly status: AdapterSupportStatus;
  /** The semver range the adapter declared. */
  readonly supportedRange: string;
  /** The version that was compared, when one was detected. */
  readonly version?: string | undefined;
}

/** Everything {@link Adapter.parse} is given. */
export interface AdapterParseInput {
  /** What detection found. */
  readonly detection: AdapterDetection;
  /** One entry per spec returned by {@link Adapter.files}, in the same order. */
  readonly files: readonly AdapterSourceFile[];
}

/**
 * Teaches Aura to read one agent application's configuration.
 *
 * The lifecycle is deliberately split so that all I/O belongs to Aura core: `detect` probes the
 * system, `files` declares which paths matter, core reads them, and `parse` turns the supplied
 * contents into a normalized snapshot.
 */
export interface Adapter {
  /**
   * Probes the system for the application.
   *
   * May run commands via {@link Environment.exec}. Must not write to disk.
   */
  readonly detect: (environment: Environment) => Promise<AdapterDetection>;
  /** Human-readable application name, shown in reports. */
  readonly displayName: string;
  /**
   * Declares which paths Aura core should read.
   *
   * Called only when {@link AdapterDetection.installed} is `true`. Must not touch the filesystem:
   * return specs unconditionally and let `exists` report the outcome.
   */
  readonly files: (
    environment: Environment,
    detection: AdapterDetection,
  ) => readonly AdapterFileSpec[];
  /** Stable adapter identifier, unique across all loaded plugins. */
  readonly id: string;
  /**
   * Normalizes the supplied file contents.
   *
   * Synchronous and pure. Must not read the filesystem, spawn processes, or inspect `process.env`
   * — everything it needs is in `input`. Malformed content should yield an empty or partial
   * snapshot rather than throwing.
   */
  readonly parse: (input: AdapterParseInput) => AdapterSnapshot;
  /** Semver range of application versions this adapter understands, for example `">=1 <2"`. */
  readonly supportedRange: string;
}
