/* eslint-disable no-restricted-properties -- workflow verification owns its process boundary */
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIRECTORY = join(ROOT, ".github/workflows");
const PINNED_EXTERNAL_ACTION = /^[^@\s]+@[0-9a-f]{40}$/u;
const USES_LINE = /^\s*(?:-\s*)?uses:\s*(.*?)\s*$/u;

function actionReference(value) {
  const withoutComment = value.replace(/\s+#.*$/u, "").trim();
  const quote = withoutComment[0];

  if ((quote === '"' || quote === "'") && withoutComment.at(-1) === quote) {
    return withoutComment.slice(1, -1);
  }

  return withoutComment;
}

function auditUsesLine(line, path, lineNumber) {
  const uses = line.match(USES_LINE);
  if (uses === null) {
    return undefined;
  }

  const reference = actionReference(uses[1]);
  if (reference.startsWith("./") || PINNED_EXTERNAL_ACTION.test(reference)) {
    return undefined;
  }

  return `${path}:${lineNumber}: external action "${reference}" must use a full 40-character lowercase commit SHA`;
}

export function auditWorkflowSource(source, path) {
  const lines = source.split(/\r?\n/u);
  const violations = lines
    .map((line, index) => auditUsesLine(line, path, index + 1))
    .filter((violation) => violation !== undefined);

  if (!lines.some((line) => /^permissions\s*:/u.test(line))) {
    violations.push(`${path}:1: workflow must declare root-level permissions`);
  }

  return violations;
}

export async function verifyWorkflowDirectory(directory = WORKFLOW_DIRECTORY) {
  const files = (await readdir(directory))
    .filter((path) => [".yaml", ".yml"].includes(extname(path)))
    .sort();
  const violations = [];

  for (const file of files) {
    const absolutePath = join(directory, file);
    const displayPath = relative(ROOT, absolutePath);
    const source = await readFile(absolutePath, "utf8");
    violations.push(...auditWorkflowSource(source, displayPath));
  }

  return { files, violations };
}

async function main() {
  const result = await verifyWorkflowDirectory();
  if (result.violations.length > 0) {
    process.stderr.write(`${result.violations.join("\n")}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`Verified ${result.files.length} GitHub Actions workflows.\n`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  await main();
}
