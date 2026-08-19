import type { ResolvedSkillPack } from "./content.js";
import type { AuraManifestMcpServer, AuraManifestState } from "./manifest.js";
import type { McpEnvironmentVariableState, ResolvedMcpServerDef } from "./mcp-definition-types.js";
import type {
  AppModel,
  InstructionDocument,
  McpServer,
  ResolvedSnippet,
  SharedInstructionsState,
  UnusableMcpServer,
} from "./model.js";
import type { RepositoryModel } from "./repository.js";
import type { McpSecretSighting } from "./mcp-secret.js";
import type { InstalledSkill, SharedSkillState } from "./skill-model.js";

/**
 * The complete normalized view of a workspace, and the only input a {@link Check} receives.
 *
 * The aggregate `instructionFiles`, `mcpServers`, and `skills` collections span every application,
 * so a check sees configuration contributed by adapters from other plugins.
 */
export interface WorkspaceModel {
  /** Registry catalog entries whose bundled JSON definitions were readable in this run. */
  readonly availableMcpServers: readonly ResolvedMcpServerDef[];
  /** Bundled skill packs whose directory sources resolved in this run. */
  readonly availableSkills?: readonly ResolvedSkillPack[] | undefined;
  /** Registry snippets whose bundled Markdown sources were readable in this run. */
  readonly availableSnippets: readonly ResolvedSnippet[];
  /** Every detected application. */
  readonly apps: readonly AppModel[];
  /** Directory Aura was invoked from. */
  readonly cwd: string;
  /** The current user's home directory. */
  readonly homeDir: string;
  /** Instruction documents across every application. */
  readonly instructionFiles: readonly InstructionDocument[];
  /** Desired Aura-managed state loaded from the distribution-independent manifest. */
  readonly manifest: AuraManifestState;
  /** MCP servers across every application. */
  readonly mcpServers: readonly McpServer[];
  /** Availability of environment variables referenced by desired MCP transports, never values. */
  readonly mcpEnvironmentVariables: readonly McpEnvironmentVariableState[];
  /** Inline MCP credential locations across every application, without credential bytes. */
  readonly mcpSecretSightings: readonly McpSecretSighting[];
  /** Repository root, when `cwd` is inside one. */
  readonly projectRoot?: string | undefined;
  /** Preset-required MCP selections projected into desired state without persisting them. */
  readonly requiredMcpServers?: readonly RequiredMcpServer[] | undefined;
  /** Preset MCP requirements deliberately omitted through recorded manifest overrides. */
  readonly overriddenRequiredMcpServers?: readonly OverriddenRequiredMcpServer[] | undefined;
  /** Repository state captured once by core, when the workspace is inside a repository. */
  readonly repository?: RepositoryModel | undefined;
  /** Canonical `~/agents/AGENTS.md` source read independently of any application adapter. */
  readonly sharedInstructions: SharedInstructionsState;
  /** Skill trees installed in Aura's canonical shared directory. */
  readonly sharedSkills?: readonly SharedSkillState[] | undefined;
  /** Installed skills across every application. */
  readonly skills: readonly InstalledSkill[];
  /**
   * Configured MCP entries across every application that Aura found by name but cannot model.
   *
   * A check comparing desired state against {@link mcpServers} alone would call one of these
   * absent, and then propose adding a name the file already declares.
   */
  readonly unusableMcpServers: readonly UnusableMcpServer[];
}

/** One virtual desired MCP entry and the preset/configuration layer that requires it. */
export interface RequiredMcpServer extends AuraManifestMcpServer {
  readonly catalogId: string;
  readonly requiredBy: string;
}

/** One preset requirement intentionally omitted from desired state. */
export interface OverriddenRequiredMcpServer {
  readonly catalogId: string;
  readonly requiredBy: string;
}
