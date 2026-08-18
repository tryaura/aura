import type { DirectorySkillSource, HttpGetRequest, HttpGetResult } from "@tryaura/aura-sdk";

import { createTestEnvironment } from "../workspace/testing.js";

export const TOKEN = "sk-fixture-secret";

export const PUBLIC_SOURCE: DirectorySkillSource = {
  id: "directory:agenticskills",
  kind: "directory",
  name: "agenticskills.io",
  url: "https://agenticskills.io",
};

export const PRIVATE_SOURCE: DirectorySkillSource = {
  id: "directory:acme",
  kind: "private-directory",
  name: "Acme Skills",
  tokenEnv: "ACME_SKILLS_TOKEN",
  url: "https://skills.acme.example",
};

export const LISTING = {
  description: "Review changes before landing.",
  id: "review",
  name: "Review",
  version: "1.0.0",
};

export const PACK = {
  ...LISTING,
  files: [{ content: "# Review skill\n", path: "SKILL.md" }],
};

export interface ScriptedDirectoryEnvironment {
  readonly requests: HttpGetRequest[];
  readonly environment: ReturnType<typeof createTestEnvironment>;
}

export function scriptedDirectoryEnvironment(
  respond: (request: HttpGetRequest, call: number) => HttpGetResult,
  variables: Readonly<Record<string, string>> = {},
): ScriptedDirectoryEnvironment {
  const requests: HttpGetRequest[] = [];
  const environment = createTestEnvironment({
    httpGet: (request) => {
      requests.push(request);
      return Promise.resolve(respond(request, requests.length));
    },
    variables,
  });
  return { environment, requests };
}

export function okDirectoryResponse(body: unknown): HttpGetResult {
  return { body: JSON.stringify(body), kind: "response", status: 200 };
}
