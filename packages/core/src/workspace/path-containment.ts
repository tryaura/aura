import { sep } from "node:path";

/** Whether `path` is a directory itself or one of its descendants. */
export function containsPath(directory: string, path: string): boolean {
  return (
    path === directory || path.startsWith(directory.endsWith(sep) ? directory : directory + sep)
  );
}
