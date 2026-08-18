import {
  defineCheck,
  type DetectedFinding,
  type Finding,
  type FixPlan,
  type InstalledSkill,
  type WorkspaceModel,
} from "@tryaura/aura-sdk";

export const skl004 = defineCheck({
  defaultSeverity: "error",
  detect: detectInvocationCollisions,
  explain:
    "Two skill entries in one scope of one application must not expose the same invocation name. Otherwise the application cannot offer a stable, unambiguous invocation target. A project skill and a global skill sharing a name is not a collision: applications resolve project skills first, so the project entry deliberately shadows the global one.\n\nRename a skill and its directory together, or remove the entry the application should not load.",
  fix: guidedCollisionRepair,
  fixability: "guided",
  id: "SKL-004",
  scope: "global",
  title: "Skill invocation names are unique per application scope",
});

/**
 * Groups by application *and scope*.
 *
 * Deploying one shared skill to every directory an application declares is the intended outcome of
 * SKL-002, and Claude Code declares both a global and a project directory. Grouping across scopes
 * would make SKL-002's own fix raise an error here and tell the user to delete one of the two links
 * Aura had just created.
 */
function detectInvocationCollisions(model: WorkspaceModel): readonly DetectedFinding[] {
  const groups = new Map<string, InstalledSkill[]>();
  for (const skill of model.skills) {
    const key = `${skill.appId}\0${skill.scope}\0${skill.invocationName ?? skill.name}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [skill]);
    } else {
      group.push(skill);
    }
  }

  const findings: DetectedFinding[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }
    const first = group[0];
    if (first === undefined) {
      continue;
    }
    const invocationName = first.invocationName ?? first.name;
    findings.push({
      details: group
        .map((skill) => `${skill.path} (${skill.sourceId ?? "unknown skill source"})`)
        .join("\n"),
      id: `${first.appId}:${first.scope}:${invocationName}`,
      locations: group.map((skill) => ({ path: skill.path })),
      message: `${first.appId} has ${String(group.length)} ${first.scope} skills named "${invocationName}".`,
      metadata: { appId: first.appId, invocationName, scope: first.scope },
    });
  }
  return findings;
}

function guidedCollisionRepair(finding: Finding): FixPlan {
  const invocationName = finding.metadata?.["invocationName"];
  const name = typeof invocationName === "string" ? invocationName : "the duplicated skill";
  return {
    manualSteps: [
      `Choose which entry should keep the invocation name "${name}".`,
      "Remove the other entry, or rename both its directory and the `name` field in SKILL.md, then run the check again.",
    ],
    operations: [],
    summary: `Resolve the invocation-name collision for "${name}".`,
  };
}
