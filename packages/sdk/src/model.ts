import type { JsonObject, Scope } from "./common.js";

export type AdapterFileKind = "config" | "instructions" | "mcp" | "skills";

export interface AdapterFileSpec {
  readonly id: string;
  readonly kind: AdapterFileKind;
  readonly optional?: boolean;
  readonly path: string;
  readonly scope: Scope;
}

export interface AdapterSourceFile {
  readonly content?: string;
  readonly exists: boolean;
  readonly spec: AdapterFileSpec;
}

export interface AdapterDetection {
  readonly authenticated?: boolean;
  readonly executablePath?: string;
  readonly installed: boolean;
  readonly metadata?: JsonObject;
  readonly version?: string;
}

export type AdapterSupportStatus = "supported" | "unknown" | "unsupported";

export interface AdapterSupport {
  readonly status: AdapterSupportStatus;
  readonly supportedRange: string;
  readonly version?: string;
}

export type InstructionLinkKind = "import" | "native" | "symlink";

export interface InstructionLink {
  readonly kind: InstructionLinkKind;
  readonly targetPath: string;
  readonly valid: boolean;
}

export interface InstructionDocument {
  readonly content: string;
  readonly links: readonly InstructionLink[];
  readonly path: string;
  readonly scope: Scope;
  readonly sourceId: string;
}

export interface StdioMcpTransport {
  readonly args?: readonly string[];
  readonly command: string;
  readonly environmentVariables?: readonly string[];
  readonly type: "stdio";
}

export interface HttpMcpTransport {
  readonly headerEnvironmentVariables?: readonly string[];
  readonly type: "http";
  readonly url: string;
}

export type McpTransport = HttpMcpTransport | StdioMcpTransport;

export interface McpServer {
  readonly appId: string;
  readonly name: string;
  readonly scope: Scope;
  readonly sourceId: string;
  readonly transport: McpTransport;
}

export interface InstalledSkill {
  readonly appId: string;
  readonly id: string;
  readonly invocationName?: string;
  readonly name: string;
  readonly path: string;
  readonly scope: Scope;
  readonly sourceId?: string;
  readonly version?: string;
}

export interface AdapterSnapshot {
  readonly instructionFiles: readonly InstructionDocument[];
  readonly mcpServers: readonly McpServer[];
  readonly metadata?: JsonObject;
  readonly skills: readonly InstalledSkill[];
}

export interface AppModel extends AdapterSnapshot {
  readonly adapterId: string;
  readonly detection: AdapterDetection;
  readonly displayName: string;
  readonly sourceFiles: readonly AdapterSourceFile[];
  readonly support: AdapterSupport;
}

export interface WorkspaceModel {
  readonly apps: readonly AppModel[];
  readonly cwd: string;
  readonly homeDir: string;
  readonly instructionFiles: readonly InstructionDocument[];
  readonly mcpServers: readonly McpServer[];
  readonly projectRoot?: string;
  readonly skills: readonly InstalledSkill[];
}
