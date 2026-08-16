import type {
  AdapterDetection,
  AdapterFileStatus,
  AdapterSharedLinkKind,
  AdapterSupport,
  FileProblem,
} from "./adapter.js";
import type { JsonObject, Scope } from "./common.js";

/** How one instruction document pulls in another. */
export type InstructionLinkKind = "import" | "native" | "symlink";

/** A reference from one instruction document to another. */
export interface InstructionLink {
  /** The mechanism the link uses. */
  readonly kind: InstructionLinkKind;
  /** Absolute path the link points at, resolved against the document that declares it. */
  readonly targetPath: string;
  /** Whether the target resolved to something that exists. */
  readonly valid: boolean;
}

/**
 * A parsed instruction file, such as `CLAUDE.md` or `AGENTS.md`.
 *
 * `content` is the full file. Instruction files are user-authored and may contain anything, so
 * never copy `content` into a {@link Finding} message or `metadata`.
 */
export interface InstructionDocument {
  /** Full file contents. */
  readonly content: string;
  /** References this document makes to other instruction files. */
  readonly links: readonly InstructionLink[];
  /**
   * Adapter-defined detail about the document, such as the activation conditions Cursor keeps in
   * `.mdc` frontmatter.
   *
   * Rendered in user-visible output. Never place credentials or file contents here.
   */
  readonly metadata?: JsonObject | undefined;
  /** Absolute path the document was read from. */
  readonly path: string;
  /** Whether this is user-level or workspace-level state. */
  readonly scope: Scope;
  /** The {@link AdapterFileSpec.id} this document came from. */
  readonly sourceId: string;
}

/** An MCP server Aura launches as a child process. */
export interface StdioMcpTransport {
  /**
   * Arguments passed to the command, with credential-bearing values replaced.
   *
   * A server is routinely launched with its token on the command line — `--api-key=…`, `-e
   * API_TOKEN=…` — so an adapter redacts those values for the same reason it records only the
   * names of {@link StdioMcpTransport.environmentVariables}. What identifies the server, such as
   * the package name and the flag names, is kept.
   */
  readonly args?: readonly string[] | undefined;
  /** Executable to run. */
  readonly command: string;
  /**
   * Names of environment variables the server needs.
   *
   * Names only — never the values. Aura reads configuration that commonly holds API tokens, and
   * recording only the names keeps them out of reports, logs, and the model.
   */
  readonly environmentVariables?: readonly string[] | undefined;
  /** Discriminant. */
  readonly type: "stdio";
}

/** An MCP server Aura reaches over HTTP. */
export interface HttpMcpTransport {
  /**
   * Names of environment variables supplying request headers.
   *
   * Names only — never the values. See {@link StdioMcpTransport.environmentVariables}.
   */
  readonly headerEnvironmentVariables?: readonly string[] | undefined;
  /**
   * Discriminant. `sse` is the Server-Sent Events transport MCP has since superseded.
   *
   * Both reach the server over HTTP. They stay distinguishable so a check can say that a server is
   * still on the older one.
   */
  readonly type: "http" | "sse";
  /**
   * Server endpoint, with credentials removed.
   *
   * Userinfo (`https://user:token@host`) and query parameter values are both ordinary places for a
   * token to sit, so an adapter strips them before the URL reaches the model. Origin, path, and
   * parameter names survive, which is what identifying the server needs.
   */
  readonly url: string;
}

/** How Aura reaches an MCP server. Discriminate on `type`. */
export type McpTransport = HttpMcpTransport | StdioMcpTransport;

/** An MCP server configured in one agent application. */
export interface McpServer {
  /** The {@link Adapter.id} that parsed this entry. */
  readonly appId: string;
  /** Server name as configured by the user. */
  readonly name: string;
  /** Whether this is user-level or workspace-level configuration. */
  readonly scope: Scope;
  /** The {@link AdapterFileSpec.id} this entry came from. */
  readonly sourceId: string;
  /** How Aura reaches the server. */
  readonly transport: McpTransport;
}

/** A skill present on disk for one agent application. */
export interface InstalledSkill {
  /** The {@link Adapter.id} that parsed this entry. */
  readonly appId: string;
  /** Skill identifier as recorded by the application. */
  readonly id: string;
  /** The name a user types to invoke the skill, when it differs from `id`. */
  readonly invocationName?: string | undefined;
  /** Human-readable skill name. */
  readonly name: string;
  /** Absolute path to the skill directory. */
  readonly path: string;
  /** Whether this is user-level or workspace-level state. */
  readonly scope: Scope;
  /** The {@link SkillSource.id} or {@link AdapterFileSpec.id} this skill came from. */
  readonly sourceId?: string | undefined;
  /** Installed version, when the skill declares one. */
  readonly version?: string | undefined;
}

/**
 * A file an adapter read successfully but could not use.
 *
 * Core learns whether a path could be opened; only the adapter knows whether the bytes are the
 * document it expected. Without this an unparsable `.mcp.json` is indistinguishable from one that
 * configures nothing, which is the difference between "you have no MCP servers" and "yours are
 * silently not loading" — the second being the answer a user ran a doctor to get.
 */
export interface AdapterProblem {
  /**
   * One sentence naming the problem, in terms the user can act on.
   *
   * Rendered in the default report, so it names the path but never quotes what the file contained:
   * the files an adapter parses are the ones holding API tokens.
   */
  readonly message: string;
  /** The {@link AdapterFileSpec.id} whose contents could not be used. */
  readonly sourceId: string;
}

/** What one adapter parsed out of the files it declared. */
export interface AdapterSnapshot {
  /** Instruction documents found for this application. */
  readonly instructionFiles: readonly InstructionDocument[];
  /** MCP servers configured for this application. */
  readonly mcpServers: readonly McpServer[];
  /**
   * Adapter-defined detail surfaced in diagnostics.
   *
   * Rendered in user-visible output. Never place credentials or file contents here.
   */
  readonly metadata?: JsonObject | undefined;
  /**
   * Declared files whose contents this adapter could not use.
   *
   * Reported to the user beside the model rather than inside it, like every other scan diagnostic,
   * so checks stay pure functions over machine state.
   */
  readonly problems?: readonly AdapterProblem[] | undefined;
  /** Skills installed for this application. */
  readonly skills: readonly InstalledSkill[];
}

/** One adapter's shared-link declaration after core resolves its entry path and template. */
export interface ResolvedSharedLink {
  /** Rendered managed snippet or whole-file content. Absent for `symlink`. */
  readonly content?: string | undefined;
  /** Absolute instruction entry path the mechanism owns or updates. */
  readonly entryPath: string;
  readonly kind: AdapterSharedLinkKind;
  /**
   * Where the entry lives, which decides how {@link content} names the shared source.
   *
   * A `global` entry sits under the home directory and refers to it as `~/agents/AGENTS.md`. A
   * `project` entry sits inside the workspace and has to use an absolute path, because no agent
   * application resolves `~` from a project file — which makes that content specific to one machine
   * and one user, and not something to commit.
   */
  readonly scope: Scope;
}

/** Core's bounded read of the canonical shared instruction source. */
export interface SharedInstructionsState {
  readonly content?: string | undefined;
  readonly exists: boolean;
  readonly path: string;
  readonly problem?: FileProblem | undefined;
}

/**
 * One agent application as Aura sees it.
 *
 * `problems` is omitted rather than inherited: it describes how well the scan went, which core
 * reports as a diagnostic beside the model instead of recording as state of the machine.
 */
export interface AppModel extends Omit<AdapterSnapshot, "problems"> {
  /** The {@link Adapter.id} that produced this model. */
  readonly adapterId: string;
  /** What detection found. */
  readonly detection: AdapterDetection;
  /** Human-readable application name. */
  readonly displayName: string;
  /** Short, non-interactive guidance for installing or updating this application. */
  readonly installHint?: string | undefined;
  /**
   * Which declared paths were found.
   *
   * Contents are intentionally absent: they were consumed by {@link Adapter.parse} and are not
   * retained alongside the documents parsed out of them.
   */
  readonly sourceFiles: readonly AdapterFileStatus[];
  /** How this application can be wired to the shared instruction source, when declared. */
  readonly sharedLink?: ResolvedSharedLink | undefined;
  /** Whether Aura understands the detected version. */
  readonly support: AdapterSupport;
}

/** One effective pattern line from a repository's root `.gitignore`. */
export interface GitignorePattern {
  /** One-based line number in `.gitignore`. */
  readonly line: number;
  /** Exact pattern text, excluding the line ending. */
  readonly value: string;
}

/** State of one file holding Git ignore patterns, captured during the workspace scan. */
export interface GitignoreModel {
  /** Exact file contents, absent when the file could not be read. */
  readonly content?: string | undefined;
  /** Whether the file exists. */
  readonly exists: boolean;
  /** Absolute path to the file. */
  readonly path: string;
  /** Effective nonblank, non-comment lines in source order. */
  readonly patterns: readonly GitignorePattern[];
  /** Why contents are unavailable when the path exists but could not be read. */
  readonly problem?: FileProblem | undefined;
}

/** Repository-specific state checks need without performing their own I/O. */
export interface RepositoryModel {
  /** Root `.gitignore`, the only ignore file Aura offers to maintain. */
  readonly gitignore: GitignoreModel;
  /**
   * Repository-local `info/exclude`, which ignores paths without touching a shared file.
   *
   * Read so that a developer who already excluded a personal path locally is not told to commit
   * the same rule to everyone else's `.gitignore`. Absent when Git could not be probed.
   */
  readonly infoExclude?: GitignoreModel | undefined;
  /**
   * Root-relative tracked paths that agent applications are known to write.
   *
   * Deliberately not every tracked path: a checkout can hold hundreds of thousands of files, and
   * retaining all of them for the lifetime of a scan costs far more than the handful of agent
   * paths a check can act on. Undefined when Git could not be probed.
   */
  readonly trackedAgentPaths?: readonly string[] | undefined;
}

/**
 * The complete normalized view of a workspace, and the only input a {@link Check} receives.
 *
 * The aggregate `instructionFiles`, `mcpServers`, and `skills` collections span every application,
 * so a check sees configuration contributed by adapters from other plugins.
 */
export interface WorkspaceModel {
  /** Every detected application. */
  readonly apps: readonly AppModel[];
  /** Directory Aura was invoked from. */
  readonly cwd: string;
  /** The current user's home directory. */
  readonly homeDir: string;
  /** Instruction documents across every application. */
  readonly instructionFiles: readonly InstructionDocument[];
  /** MCP servers across every application. */
  readonly mcpServers: readonly McpServer[];
  /** Repository root, when `cwd` is inside one. */
  readonly projectRoot?: string | undefined;
  /** Repository state captured once by core, when the workspace is inside a repository. */
  readonly repository?: RepositoryModel | undefined;
  /** Canonical `~/agents/AGENTS.md` source read independently of any application adapter. */
  readonly sharedInstructions: SharedInstructionsState;
  /** Installed skills across every application. */
  readonly skills: readonly InstalledSkill[];
}
