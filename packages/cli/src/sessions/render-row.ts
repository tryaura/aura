import { safe } from "../safe-text.js";
import { wrapWords } from "../text-width.js";

/** One report row wrapped to the column budget, every wrapped line keeping the same indent. */
export function wrappedRow(text: string, indent: string, columns: number): readonly string[] {
  return wrapWords(text, Math.max(1, columns - indent.length)).map((line) => `${indent}${line}`);
}

/** A resolved repository name prints as-is; a path label shortens under home like any other. */
export function displayProject(project: string, homeDir: string): string {
  const shortened = project.startsWith(`${homeDir}/`)
    ? `~${project.slice(homeDir.length)}`
    : project;
  return safe(shortened);
}
