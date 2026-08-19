import type { DirectorySkillSource } from "@tryaura/aura-sdk";

import { isAllowedHttpUrl } from "../http.boundary.js";

/**
 * Directory source ids are global, so the whole id is validated here rather than a namespace
 * suffix: `directory:` followed by one kebab-case name.
 */
const DIRECTORY_SOURCE_ID_PATTERN = /^directory:[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** Same grammar the MCP catalog uses: a variable is named, its value never appears in config. */
const TOKEN_ENV_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;

/**
 * Why a directory source cannot be registered, or `undefined` when it can.
 *
 * Shared by the plugin registry and the team-preset parser so both surfaces refuse the same
 * shapes with the same words.
 */
export function directorySourceProblem(source: DirectorySkillSource): string | undefined {
  if (source.id.length > 74 || !DIRECTORY_SOURCE_ID_PATTERN.test(source.id)) {
    return (
      `declares ID "${source.id}"; expected "directory:" followed by a kebab-case name ` +
      "of at most 64 characters"
    );
  }

  let url: URL;
  try {
    url = new URL(source.url);
  } catch {
    return "declares a URL that is not absolute";
  }
  if (!isAllowedHttpUrl(url)) {
    return "declares a URL; expected https (plain http is loopback-only)";
  }
  if (url.username !== "" || url.password !== "") {
    return "declares a URL with embedded username or password credentials, which are not allowed";
  }
  if (url.search !== "" || url.hash !== "") {
    return "declares a URL with a query string or fragment, which is not allowed";
  }

  if (source.kind === "private-directory" && !TOKEN_ENV_PATTERN.test(source.tokenEnv)) {
    return (
      `declares token variable "${source.tokenEnv}"; expected an environment variable name ` +
      "of uppercase letters, digits, and underscores — a name, never a value"
    );
  }

  return undefined;
}
