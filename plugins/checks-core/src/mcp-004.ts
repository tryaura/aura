import { canPlanMcpSecretRemediation, planMcpSecretRemediation } from "@tryaura/core";
import {
  defineCheck,
  type DetectedFinding,
  type Finding,
  type GuidedFixChoice,
  type McpSecretSighting,
  type WorkspaceModel,
} from "@tryaura/aura-sdk";

const EXPLAIN = `Inline credentials in MCP configuration can leak through source control, logs, diagnostics, and copied configuration. Aura identifies credential-bearing fields without retaining their values, prefixes, or lengths.

Re-run with \`--fix --interactive\` to replace every behavior-preserving sighting in the same source file with an environment reference. Copy the current values directly from the named file before applying the rewrite; Aura never displays or stores those values outside the protected undo payload, which stays owner-only under \`~/agents/.backups\` until twenty later fixes have pushed it out of the journal. Then rotate each credential at its issuer: moving a value behind an environment reference stops it leaking again, not from wherever it has already reached.`;

export const mcp004 = defineCheck({
  defaultSeverity: "error",
  detect: detectInlineSecrets,
  explain: EXPLAIN,
  fix: remediation,
  fixability: "guided",
  guidedFixes,
  id: "MCP-004",
  scope: "global",
  title: "MCP credentials use environment references",
});

function detectInlineSecrets(model: WorkspaceModel): readonly DetectedFinding[] {
  return model.mcpSecretSightings.map((sighting) => {
    const supported = canPlanMcpSecretRemediation(model, sighting);
    const path = sourcePath(model, sighting);
    return {
      details: supported
        ? `Aura can replace this field with ${sighting.suggestedEnvName} as part of a whole-file guided rewrite.`
        : manualDetails(sighting),
      ...(supported ? {} : { fixability: "manual" }),
      id: `${sighting.appId}:${sighting.sourceId}:${sighting.serverName}:${sighting.field}`,
      ...(path === undefined ? {} : { locations: [{ path }] }),
      message: `MCP server ${sighting.serverName} in ${sighting.appId} stores a credential inline at ${sighting.field}.`,
      metadata: {
        appId: sighting.appId,
        field: sighting.field,
        serverName: sighting.serverName,
        sourceId: sighting.sourceId,
        suggestedEnvName: sighting.suggestedEnvName,
      },
    };
  });
}

function remediation(finding: Finding, model: WorkspaceModel) {
  const sighting = findingSighting(finding, model);
  return sighting === undefined ? undefined : planMcpSecretRemediation(model, sighting);
}

function guidedFixes(finding: Finding, model: WorkspaceModel): readonly GuidedFixChoice[] {
  const plan = remediation(finding, model);
  return plan === undefined
    ? []
    : [
        {
          id: "replace-file-secrets",
          label: "Replace inline credentials in this file",
          plan,
        },
      ];
}

function findingSighting(finding: Finding, model: WorkspaceModel): McpSecretSighting | undefined {
  const appId = finding.metadata?.["appId"];
  const sourceId = finding.metadata?.["sourceId"];
  const serverName = finding.metadata?.["serverName"];
  const field = finding.metadata?.["field"];
  return model.mcpSecretSightings.find(
    (sighting) =>
      sighting.appId === appId &&
      sighting.sourceId === sourceId &&
      sighting.serverName === serverName &&
      sighting.field === field,
  );
}

function sourcePath(model: WorkspaceModel, sighting: McpSecretSighting): string | undefined {
  return model.apps
    .find((app) => app.adapterId === sighting.appId)
    ?.sourceFiles.find((file) => file.spec.id === sighting.sourceId)?.spec.path;
}

function manualDetails(sighting: McpSecretSighting): string {
  return sighting.appId === "codex"
    ? `Aura cannot rewrite ${sighting.field} without changing how Codex reads it — either the field has no environment-reference form, or the entry is not written as a \`[mcp_servers.${sighting.serverName}]\` table. Move the credential manually to an environment-aware field, then run \`aura check\` again.`
    : `This adapter cannot safely rewrite ${sighting.field}. Replace it manually with ${sighting.suggestedEnvName}, then run \`aura check\` again.`;
}
