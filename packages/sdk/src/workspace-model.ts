import type { ResolvedSkillPack } from "./content.js";
import type { AuraManifestState } from "./manifest.js";
import type { ResolvedMcpServerDef } from "./mcp-definition-types.js";
import type {
  AppModel,
  InstructionDocument,
  McpServer,
  ResolvedSnippet,
  SharedInstructionsState,
} from "./model.js";
import type { RepositoryModel } from "./repository.js";
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
  /** Repository root, when `cwd` is inside one. */
  readonly projectRoot?: string | undefined;
  /** Repository state captured once by core, when the workspace is inside a repository. */
  readonly repository?: RepositoryModel | undefined;
  /** Canonical `~/agents/AGENTS.md` source read independently of any application adapter. */
  readonly sharedInstructions: SharedInstructionsState;
  /** Skill trees installed in Aura's canonical shared directory. */
  readonly sharedSkills?: readonly SharedSkillState[] | undefined;
  /** Installed skills across every application. */
  readonly skills: readonly InstalledSkill[];
}
