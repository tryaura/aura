import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkspaceModel } from "@tryaura/aura-sdk";

export interface FixPlanFixture {
  readonly home: string;
  readonly model: WorkspaceModel;
  readonly root: string;
  readonly workspace: string;
}

export async function createFixPlanFixture(): Promise<FixPlanFixture> {
  const root = await mkdtemp(join(tmpdir(), "aura-fix-plan-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  await mkdir(home);
  await mkdir(workspace);

  return {
    home,
    model: {
      apps: [],
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
