import type { AdapterDetection, AdapterFileStatus, AdapterSupport } from "./adapter.js";
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
  /** Absolute path the document was read from. */
  readonly path: string;
  /** Whether this is user-level or workspace-level state. */
  readonly scope: Scope;
  /** The {@link AdapterFileSpec.id} this document came from. */
  readonly sourceId: string;
}

/** An MCP server Aura launches as a child process. */
export interface StdioMcpTransport {
  /** Arguments passed to the command verbatim. */
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
  /** Discriminant. */
  readonly type: "http";
  /** Server endpoint. */
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
  /** Skills installed for this application. */
  readonly skills: readonly InstalledSkill[];
}

/** One agent application as Aura sees it. */
export interface AppModel extends AdapterSnapshot {
  /** The {@link Adapter.id} that produced this model. */
  readonly adapterId: string;
  /** What detection found. */
  readonly detection: AdapterDetection;
  /** Human-readable application name. */
  readonly displayName: string;
  /**
   * Which declared paths were found.
   *
   * Contents are intentionally absent: they were consumed by {@link Adapter.parse} and are not
   * retained alongside the documents parsed out of them.
   */
  readonly sourceFiles: readonly AdapterFileStatus[];
  /** Whether Aura understands the detected version. */
  readonly support: AdapterSupport;
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
  /** Installed skills across every application. */
  readonly skills: readonly InstalledSkill[];
}
