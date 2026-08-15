import type { Fixability, JsonObject, Scope, Severity } from "./common.js";
import type { FixPlan } from "./fix.js";
import type { WorkspaceModel } from "./model.js";

export interface FindingLocation {
  readonly column?: number;
  readonly line?: number;
  readonly path: string;
}

export interface Finding {
  readonly checkId: string;
  readonly details?: string;
  readonly id: string;
  readonly locations?: readonly FindingLocation[];
  readonly message: string;
  readonly metadata?: JsonObject;
  readonly scope: Scope;
  readonly severity: Severity;
}

export interface Check {
  readonly defaultSeverity: Severity;
  readonly detect: (model: WorkspaceModel) => readonly Finding[];
  readonly explain: string;
  readonly fix?: (finding: Finding, model: WorkspaceModel) => FixPlan | null;
  readonly fixability: Fixability;
  readonly id: string;
  readonly scope: Scope;
  readonly title: string;
}
