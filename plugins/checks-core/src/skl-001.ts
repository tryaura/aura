import {
  defineCheck,
  type DetectedFinding,
  type Finding,
  type FixPlan,
  type SharedSkillState,
  type WorkspaceModel,
} from "@tryaura/aura-sdk";

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_SKILL_NAME_LENGTH = 64;
const MAX_SKILL_DESCRIPTION_LENGTH = 300;

export const skl001 = defineCheck({
  defaultSeverity: "error",
  detect: detectSharedSkillIntegrity,
  explain:
    "Every shared skill needs a readable SKILL.md with valid Agent Skills frontmatter and local references that resolve inside its own tree. Broken metadata can prevent discovery, while missing referenced files leave the skill incomplete.\n\nRepair the named definition or referenced file, then run the check again.",
  fix: guidedRepair,
  fixability: "guided",
  id: "SKL-001",
  scope: "global",
  title: "Shared skills have valid definitions and references",
});

function detectSharedSkillIntegrity(model: WorkspaceModel): readonly DetectedFinding[] {
  return (model.sharedSkills ?? []).flatMap((skill) => integrityFindings(skill));
}

function integrityFindings(skill: SharedSkillState): readonly DetectedFinding[] {
  const definition = definitionFinding(skill);
  if (definition !== undefined) {
    return [definition];
  }
  if (skill.definitionStatus !== "ready") {
    return [];
  }
  return [...nameFindings(skill), ...descriptionFindings(skill), ...referenceFindings(skill)];
}

function definitionFinding(skill: SharedSkillState): DetectedFinding | undefined {
  // The tree walk stops at the first entry it cannot resolve, so a problem anywhere in the tree can
  // be why the definition was never read. Reporting it before the definition status keeps the
  // message pointed at the entry that actually needs fixing.
  if (skill.problem !== undefined) {
    return {
      ...(skill.problemDetail === undefined ? {} : { details: skill.problemDetail }),
      id: `${skill.id}:unreadable-tree`,
      locations: [{ path: skill.path }],
      message: `Shared skill "${skill.id}" could not be read in full (${skill.problem}).`,
      metadata: { kind: "unreadable-tree", skillId: skill.id },
    };
  }
  if (skill.definitionStatus === "missing-file") {
    return finding(skill, "missing-file", `Shared skill "${skill.id}" has no SKILL.md.`);
  }
  if (skill.definitionStatus === "unreadable") {
    return finding(skill, "unreadable", `Shared skill "${skill.id}" has an unreadable SKILL.md.`);
  }
  if (skill.definitionStatus === "invalid-frontmatter") {
    return finding(
      skill,
      "invalid-frontmatter",
      `Shared skill "${skill.id}" has invalid YAML frontmatter.`,
    );
  }
  return undefined;
}

function nameFindings(skill: SharedSkillState): readonly DetectedFinding[] {
  const findings: DetectedFinding[] = [];
  const invalid = new Set(skill.invalidFrontmatterFields ?? []);
  if (invalid.has("name")) {
    findings.push(
      finding(skill, "invalid-name-field", `Shared skill "${skill.id}" has a non-string name.`),
    );
  } else if (skill.name === undefined || skill.name.trim().length === 0) {
    findings.push(finding(skill, "missing-name", `Shared skill "${skill.id}" has no name.`));
  } else {
    if (skill.name.length > MAX_SKILL_NAME_LENGTH || !SKILL_NAME_PATTERN.test(skill.name)) {
      findings.push(
        finding(
          skill,
          "invalid-name",
          `Shared skill "${skill.id}" has name "${skill.name}", which is not kebab-case of at most 64 characters.`,
        ),
      );
    }
    if (skill.name !== skill.id) {
      findings.push(
        finding(
          skill,
          "name-mismatch",
          `Shared skill directory "${skill.id}" declares the name "${skill.name}".`,
        ),
      );
    }
  }
  return findings;
}

function descriptionFindings(skill: SharedSkillState): readonly DetectedFinding[] {
  const invalid = new Set(skill.invalidFrontmatterFields ?? []);
  if (invalid.has("description")) {
    return [
      finding(
        skill,
        "invalid-description-field",
        `Shared skill "${skill.id}" has a non-string description.`,
      ),
    ];
  }
  if (skill.description === undefined || skill.description.trim().length === 0) {
    return [
      finding(skill, "missing-description", `Shared skill "${skill.id}" has no description.`),
    ];
  }
  return skill.description.length > MAX_SKILL_DESCRIPTION_LENGTH
    ? [
        finding(
          skill,
          "long-description",
          `Shared skill "${skill.id}" has a description longer than 300 characters.`,
        ),
      ]
    : [];
}

function referenceFindings(skill: SharedSkillState): readonly DetectedFinding[] {
  const findings: DetectedFinding[] = [];
  for (const reference of skill.references ?? []) {
    if (!reference.valid) {
      findings.push({
        id: `${skill.id}:missing-reference:${reference.path}`,
        locations: [{ path: skill.skillFilePath ?? skill.path }, { path: reference.path }],
        message: `Shared skill "${skill.id}" references missing file ${reference.path}.`,
        metadata: { kind: "missing-reference", skillId: skill.id },
      });
    }
  }
  return findings;
}

function finding(skill: SharedSkillState, kind: string, message: string): DetectedFinding {
  return {
    id: `${skill.id}:${kind}`,
    locations: [{ path: skill.skillFilePath ?? skill.path }],
    message,
    metadata: { kind, skillId: skill.id },
  };
}

function guidedRepair(finding: Finding): FixPlan {
  const path = finding.locations?.[0]?.path;
  const location = path === undefined ? "the shared skill definition" : path;
  return {
    manualSteps: [
      `Repair ${location} so its SKILL.md, frontmatter fields, directory name, and local references match the finding.`,
      "Run `aura check --only SKL-001` again.",
    ],
    operations: [],
    summary: "Repair the shared skill definition manually.",
  };
}
