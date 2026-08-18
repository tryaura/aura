import type { AST } from "toml-eslint-parser";

import { findKeyValue, findTable, keyPath } from "./toml-lookup.js";

/** A replacement of one byte range of the source, applied without reformatting anything else. */
export interface TextEdit {
  readonly end: number;
  readonly start: number;
  readonly text: string;
}

/** Rewrites a record in whichever of TOML's three spellings the document already uses. */
// fallow-ignore-next-line complexity -- preserves inline, dotted, and nested TOML table representations.
export function replaceRecord(
  ast: AST.TOMLProgram,
  source: string,
  table: AST.TOMLTable,
  path: readonly string[],
  value: Readonly<Record<string, string>>,
  edits: TextEdit[],
): void {
  const direct = findKeyValue(table, path);
  if (direct !== undefined) {
    edits.push({
      end: direct.value.range[1],
      start: direct.value.range[0],
      text: tomlInlineRecord(value),
    });
    return;
  }
  const dotted = table.body.filter((node) => {
    const key = keyPath(node);
    return key.length === path.length + 1 && path.every((part, index) => key[index] === part);
  });
  if (dotted.length > 0) {
    for (const node of dotted) {
      const name = keyPath(node).at(-1) ?? "";
      if (!Object.hasOwn(value, name)) {
        edits.push(lineRemoval(source, node.range[0], node.range[1]));
      }
    }
    return;
  }
  const nested = findTable(ast, [...table.resolvedKey.map(String), ...path]);
  if (nested === undefined) {
    return;
  }
  for (const node of nested.body) {
    if (Object.hasOwn(value, keyPath(node)[0] ?? "")) {
      continue;
    }
    edits.push(lineRemoval(source, node.range[0], node.range[1]));
  }
}

/** Sets a top-level key of a server table, appending it when the table does not declare one. */
export function replaceOrInsert(
  source: string,
  table: AST.TOMLTable,
  name: string,
  value: string,
  edits: TextEdit[],
): void {
  const existing = findKeyValue(table, [name]);
  if (existing !== undefined) {
    edits.push({ end: existing.value.range[1], start: existing.value.range[0], text: value });
    return;
  }
  const at = lineEnd(source, table.range[1]);
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const prefix = at > 0 && source[at - 1] !== "\n" ? eol : "";
  edits.push({ end: at, start: at, text: `${prefix}${name} = ${value}${eol}` });
}

function lineRemoval(source: string, start: number, end: number): TextEdit {
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  return { end: lineEnd(source, end), start: lineStart, text: "" };
}

function lineEnd(source: string, offset: number): number {
  const newline = source.indexOf("\n", offset);
  return newline === -1 ? source.length : newline + 1;
}

/**
 * Applies edits back to front so earlier ranges keep the offsets they were measured against.
 *
 * Two edits that name the same range are the same decision reached twice, except for insertions at
 * one point, which concatenate. Overlapping-but-unequal ranges would splice one edit into text
 * another had already replaced, so they return nothing rather than a corrupted document.
 */
export function applyEdits(source: string, edits: readonly TextEdit[]): string | undefined {
  const unique = new Map<string, TextEdit>();
  for (const edit of edits) {
    const key = `${edit.start}:${edit.end}`;
    const previous = unique.get(key);
    unique.set(
      key,
      previous !== undefined && edit.start === edit.end
        ? { ...edit, text: `${previous.text}${edit.text}` }
        : edit,
    );
  }
  const ordered = [...unique.values()].sort(
    (left, right) => right.start - left.start || right.end - left.end,
  );
  for (const [index, edit] of ordered.entries()) {
    const next = ordered[index + 1];
    if (next !== undefined && next.end > edit.start) {
      return undefined;
    }
  }
  return ordered.reduce(
    (content, edit) => `${content.slice(0, edit.start)}${edit.text}${content.slice(edit.end)}`,
    source,
  );
}

export function tomlArrayValues(values: readonly unknown[]): string {
  return `[${values.map(tomlValue).join(", ")}]`;
}

export function tomlInlineRecord(value: Readonly<Record<string, string>>): string {
  const entries = Object.entries(value).map(
    ([name, entry]) => `${tomlKey(name)} = ${tomlString(entry)}`,
  );
  return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
}

export function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/u.test(value) ? value : tomlString(value);
}

function tomlValue(value: unknown): string {
  if (typeof value === "string") {
    return tomlString(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return tomlArrayValues(value);
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).map(
      ([name, entry]) => `${tomlKey(name)} = ${tomlValue(entry)}`,
    );
    return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
  }
  throw new TypeError("Unsupported value in Codex env_vars.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
