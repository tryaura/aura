import type { Environment } from "./environment.js";
import type {
  AdapterDetection,
  AdapterFileSpec,
  AdapterSnapshot,
  AdapterSourceFile,
} from "./model.js";

export interface AdapterParseInput {
  readonly detection: AdapterDetection;
  readonly files: readonly AdapterSourceFile[];
}

export interface Adapter {
  readonly id: string;
  readonly displayName: string;
  readonly supportedRange: string;
  readonly detect: (environment: Environment) => Promise<AdapterDetection>;
  readonly files: (
    environment: Environment,
    detection: AdapterDetection,
  ) => readonly AdapterFileSpec[];
  readonly parse: (input: AdapterParseInput) => AdapterSnapshot;
}
