import {
  isConfigRecord,
  parseConfigObject,
  type AdapterSourceFile,
  type JsonObject,
} from "@tryaura/aura-sdk";

/** Extracts only non-sensitive permission summary fields used by environment checks. */
export function parsePermissionSettings(file: AdapterSourceFile): JsonObject | undefined {
  const root = parseConfigObject(file.content, JSON.parse);
  const permissions = root?.["permissions"];
  if (!isConfigRecord(permissions)) {
    return undefined;
  }

  const defaultMode = permissions["defaultMode"];
  const allow = permissions["allow"];
  const deny = permissions["deny"];
  const summary: Record<string, string | number> = {};

  if (typeof defaultMode === "string") {
    summary["defaultMode"] = defaultMode;
  }
  if (Array.isArray(allow)) {
    summary["allowCount"] = allow.length;
  }
  if (Array.isArray(deny)) {
    summary["denyCount"] = deny.length;
  }

  return Object.keys(summary).length === 0 ? undefined : summary;
}
