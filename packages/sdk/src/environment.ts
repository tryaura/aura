export type EnvironmentPlatform = "darwin" | "linux" | "win32";

export interface ExecRequest {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly input?: string;
  readonly timeoutMs?: number;
}

export interface ExecResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface Environment {
  readonly cwd: string;
  readonly homeDir: string;
  readonly pathEntries: readonly string[];
  readonly platform: EnvironmentPlatform;
  readonly exec: (request: ExecRequest) => Promise<ExecResult>;
  readonly now: () => Date;
}
