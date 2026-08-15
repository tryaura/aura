import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AdapterFileStatus, WorkspaceModel } from "@tryaura/aura-sdk";

export interface FixPlanFixture {
  readonly home: string;
  readonly model: WorkspaceModel;
  readonly root: string;
  readonly workspace: string;
}

/**
 * A workspace whose one adapter declares global configuration under `<home>/agents`.
 *
 * The managed home roots a plan may write to are derived from what adapters declared, so a fixture
 * has to declare something to have any.
 */
export async function createFixPlanFixture(): Promise<FixPlanFixture> {
  const root = await mkdtemp(join(tmpdir(), "aura-fix-plan-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  await mkdir(home);
  await mkdir(workspace);

  return {
    home,
    model: {
      apps: [
        {
          adapterId: "fixture",
          detection: { installed: true },
          displayName: "Fixture",
          instructionFiles: [],
          mcpServers: [],
          skills: [],
          sourceFiles: [
            sourceFile("instructions", "instructions", join(home, "agents", "AGENTS.md")),
            sourceFile("skills", "skills", join(home, "agents", "skills")),
          ],
          support: { status: "supported", supportedRange: "*" },
        },
      ],
      cwd: workspace,
      homeDir: home,
      instructionFiles: [],
      mcpServers: [],
      projectRoot: workspace,
      skills: [],
    },
    root,
    workspace,
  };
}

function sourceFile(
  id: string,
  kind: AdapterFileStatus["spec"]["kind"],
  path: string,
): AdapterFileStatus {
  return { exists: false, spec: { id, kind, path, scope: "global" } };
}
