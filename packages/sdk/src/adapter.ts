import type { AdapterCapabilities } from "./capabilities.js";
import type { JsonObject, Scope } from "./common.js";
import type { Environment } from "./environment.js";
import type { AdapterSnapshot } from "./model.js";
import type { McpWrite } from "./mcp-write.js";
import type { McpSecretTransform } from "./mcp-secret.js";
import type { AdapterSharedLink } from "./shared-link.js";

/** What an adapter expects a declared filesystem path to contain. */
export type AdapterFileKind = "config" | "instructions" | "mcp" | "probe" | "skills";

/** What kind of filesystem entry supplied an adapter source. */
export type AdapterPathKind = "directory" | "file" | "symlink";

/** A file or directory an adapter asks Aura core to read on its behalf. */
export interface AdapterFileSpec {
  /**
   * Stable identifier for this slot, unique within the adapter.
   *
   * Parsed artifacts carry it forward as `sourceId` so a finding can be traced to the file it
   * came from.
   */
  readonly id: string;
  /**
   * What the adapter expects to find here. A `probe` captures metadata without file contents and
   * is omitted from the application's final `sourceFiles` list.
   */
  readonly kind: AdapterFileKind;
  /**
   * Maximum bytes of file contents to capture.
   *
   * Core normally refuses files above its global safety limit. An adapter may set a smaller limit
   * when the application itself deliberately truncates a file, so Aura models the same prefix
   * without reading the unused remainder.
   */
  readonly maxBytes?: number | undefined;
  /** Whether a missing path is normal. A required path that is absent is reported to the user. */
  readonly optional?: boolean | undefined;
  /**
   * Absolute path. Build it from {@link Environment.homeDir} or {@link Environment.cwd}.
   *
   * A relative path is refused rather than read: Node would resolve it against the process working
   * directory, which is exactly the ambient state {@link Environment} exists to replace.
   */
  readonly path: string;
  /**
   * Application-specific project root that contains this path.
   *
   * Core normally confines project paths to its detected repository root. Set this only when the
   * application uses a different root that the adapter discovered from trusted global
   * configuration; core canonicalizes it before applying the same containment check.
   */
  readonly projectBoundary?: string | undefined;
  /** Whether this is user-level or workspace-level state. */
  readonly scope: Scope;
}

/**
 * Why Aura core captured no contents for a path that it could not simply call absent.
 *
 * Distinguishing these from absence matters: an adapter that treats an unreadable config as an
 * empty one reports "no MCP servers configured" about a file that is sitting right there.
 */
export type FileProblem =
  | "denied"
  | "loop"
  | "outside-project"
  | "resources"
  | "too-large"
  | "too-many-entries"
  | "unreadable"
  | "unsupported";

/** Whether a declared path was found, without its contents. */
export interface AdapterFileStatus {
  /** Whether the path existed and could be inspected when Aura core read it. */
  readonly exists: boolean;
  /** Why no contents were captured, when the reason was something other than absence. */
  readonly problem?: FileProblem | undefined;
  /** The kind of entry found at the declared path. Absent when the path was missing. */
  readonly pathKind?: AdapterPathKind | undefined;
  /** Canonical target path when the final entry is a symbolic link that resolves. */
  readonly resolvedPath?: string | undefined;
  /** File size in bytes, when core could inspect a regular file or a symlink to one. */
  readonly size?: number | undefined;
  /** The spec that requested this path. */
  readonly spec: AdapterFileSpec;
  /** Raw link target when {@link pathKind} is `symlink`. */
  readonly symlinkTarget?: string | undefined;
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
  /**
   * Names of the directory's immediate children, sorted, when the path is a directory.
   *
   * One level only, and names rather than paths. A `skills` spec is how an adapter discovers what
   * is installed; to look inside a child, return a spec for its path from a later
   * {@link Adapter.files} call.
   */
  readonly entries?: readonly string[] | undefined;
}

/** Files core has read for an adapter, keyed by {@link AdapterFileSpec.id}. */
export type AdapterFileMap = ReadonlyMap<string, AdapterSourceFile>;

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

/** Everything {@link Adapter.files} is given. */
export interface AdapterFilesInput {
  /** What detection found. */
  readonly detection: AdapterDetection;
  /**
   * The injected system seams, for building declared paths from {@link Environment.homeDir} and
   * {@link Environment.cwd}. `files` must not touch the filesystem through it or anything else.
   */
  readonly environment: Environment;
  /** Every source file core has read so far, keyed by its stable spec id. Empty on the first call. */
  readonly files: AdapterFileMap;
  /**
   * Repository root containing {@link Environment.cwd}, resolved by core before the first call and
   * `undefined` outside a repository. It is the same value {@link AdapterParseInput.projectRoot}
   * carries.
   */
  readonly projectRoot?: string | undefined;
}

/** Everything {@link Adapter.parse} is given. */
export interface AdapterParseInput {
  /** Directory Aura was invoked from. */
  readonly cwd: string;
  /** What detection found. */
  readonly detection: AdapterDetection;
  /** Every source file core discovered, keyed by its stable spec id. */
  readonly files: AdapterFileMap;
  /**
   * Root of the primary Git checkout associated with the current project.
   *
   * Equal to `projectRoot` for a normal checkout and different for a linked worktree. Undefined
   * when the project is not a Git repository or its worktree metadata could not be resolved.
   */
  readonly gitMainWorktreeRoot?: string | undefined;
  /** The current user's home directory. */
  readonly homeDir: string;
  /** Repository root containing {@link AdapterParseInput.cwd}, when one was found. */
  readonly projectRoot?: string | undefined;
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
   * Declarative facts about the application, read by checks instead of hard-coded adapter tables.
   *
   * Optional, with documented per-field fallbacks, so an adapter that declares nothing keeps its
   * pre-capability behavior.
   */
  readonly capabilities?: AdapterCapabilities | undefined;
  /**
   * Probes the system for the application.
   *
   * May run commands via {@link Environment.exec}. Must not write to disk.
   */
  readonly detect: (environment: Environment) => Promise<AdapterDetection>;
  /**
   * Names what {@link Adapter.detect} looks at, completing `<displayName> — looked for <scope>`
   * wherever Aura lists applications it did not find, for example
   * `"the codex CLI on PATH (the desktop app is not checked)"`.
   *
   * Detection typically probes one artifact, and the application often exists in other forms the
   * probe cannot see — a desktop app alongside a CLI. Naming the probe keeps "not found" from
   * claiming more than was checked.
   *
   * State the scope, never the outcome: Aura supplies the outcome, and only where it holds. A
   * `detect` that threw establishes nothing about the machine, so no scope is shown for it — a
   * value phrased as `"the codex CLI was not found"` would smuggle a claim past that guard.
   * Listings fall back to a bare "not found" when this is omitted.
   */
  readonly detectionScope?: string | undefined;
  /** Human-readable application name, shown in reports. */
  readonly displayName: string;
  /**
   * Declares which paths Aura core should read.
   *
   * Called only when {@link AdapterDetection.installed} is `true`. The first call receives an empty
   * file map. Core reads new specs, adds their results to the map, and calls this function again
   * until it returns no new spec ids. Returning a previously declared id is allowed only when the
   * spec is unchanged. Must not touch the filesystem: use the supplied results to discover child
   * paths and let `exists` report read outcomes.
   *
   * An application that reads configuration from the repository root — or from every directory
   * between it and the invocation directory — needs {@link AdapterFilesInput.projectRoot} to
   * declare those paths at all, since {@link Environment} deliberately carries no filesystem
   * access of its own.
   */
  readonly files: (input: AdapterFilesInput) => readonly AdapterFileSpec[];
  /**
   * Stable adapter identifier, unique across all loaded plugins.
   *
   * Unlike every other contribution id, this one is deliberately not namespaced by the owning
   * {@link AuraPlugin.id}: it names the application itself, such as `"claude-code"`. Two plugins
   * teaching Aura to read the same application must collide rather than coexist.
   */
  readonly id: string;
  /** Short, non-interactive guidance for installing or updating this application. */
  readonly installHint?: string | undefined;
  /** Pure serializer for this application's declared MCP configuration targets. */
  readonly mcpWrite?: McpWrite | undefined;
  /** Private, value-eliding MCP credential rewrite and preview-redaction behavior. */
  readonly mcpSecrets?: McpSecretTransform | undefined;
  /**
   * Normalizes the supplied file contents.
   *
   * Synchronous and pure. Must not read the filesystem, spawn processes, or inspect `process.env`
   * — everything it needs is in `input`. Malformed content should yield an empty or partial
   * snapshot rather than throwing.
   */
  readonly parse: (input: AdapterParseInput) => AdapterSnapshot;
  /**
   * Optional mechanism for linking this app to the repository's shared `AGENTS.md`, at `./...`.
   *
   * Omit it when the application already reads `AGENTS.md` at the project root: an entry that
   * only points at a file the application would have loaded anyway is one more file in somebody
   * else's repository, earning nothing.
   */
  readonly projectSharedLink?: AdapterSharedLink | undefined;
  /**
   * Optional mechanism for linking this app to the shared instruction source, at `~/...`.
   *
   * When the application keeps its global guidance somewhere Aura cannot write, omit this field
   * and declare `capabilities.instructions.globalSharedLink` as `"not-applicable"`. A bare omission
   * preserves the backward-compatible fallback: checks report that the adapter has no declared
   * mechanism instead of silently losing coverage.
   */
  readonly sharedLink?: AdapterSharedLink | undefined;
  /** Semver range of application versions this adapter understands, for example `">=1 <2"`. */
  readonly supportedRange: string;
  /**
   * Whether this adapter models files rather than an application the user installed.
   *
   * An inventory adapter reports itself installed so that core reads its paths, but naming it
   * where Aura lists applications would claim the user runs something they have never heard of.
   * Core carries the flag through to {@link AppModel.synthetic} so that user-facing lists and
   * checks written about real applications can exclude it once, rather than each by name.
   */
  readonly synthetic?: boolean | undefined;
}
