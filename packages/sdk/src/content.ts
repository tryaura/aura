import type { Environment } from "./environment.js";

export interface FileContentSource {
  readonly type: "file";
  readonly url: string;
}

export interface DirectoryContentSource {
  readonly type: "directory";
  readonly url: string;
}

export interface Snippet {
  readonly description: string;
  readonly id: string;
  readonly name: string;
  readonly source: FileContentSource;
  readonly version: string;
}

export interface SkillPack {
  readonly description: string;
  readonly id: string;
  readonly name: string;
  readonly source: DirectoryContentSource;
  readonly version: string;
}

export interface McpServerDef {
  readonly description: string;
  readonly id: string;
  readonly name: string;
  readonly source: FileContentSource;
  readonly version: string;
}

export interface Preset {
  readonly description: string;
  readonly id: string;
  readonly name: string;
  readonly source: FileContentSource;
  readonly version: string;
}

export interface SkillListing {
  readonly description: string;
  readonly id: string;
  readonly name: string;
  readonly version: string;
}

export interface SkillSource {
  readonly description: string;
  readonly id: string;
  readonly list: (environment: Environment) => Promise<readonly SkillListing[]>;
  readonly name: string;
  readonly resolve: (environment: Environment, skillId: string) => Promise<SkillPack | undefined>;
}
