import type { GitHubLocation } from "./agenticskills-types.js";

/**
 * The GitHub endpoints the provider adapter is allowed to reach.
 *
 * Every component is percent-encoded on the way in, so a repository, ref, or path that survived
 * validation still cannot introduce a path segment, a query, or a host of its own.
 */
function repositoryApiUrl(location: GitHubLocation): string {
  return `https://api.github.com/repos/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repository)}`;
}

export function contentsApiUrl(location: GitHubLocation, remotePath: string): string {
  const suffix = remotePath === "" ? "" : `/${encodePath(remotePath)}`;
  return `${repositoryApiUrl(location)}/contents${suffix}?ref=${encodeURIComponent(location.ref)}`;
}

export function rawFileUrl(location: GitHubLocation, remotePath: string): string {
  return (
    `https://raw.githubusercontent.com/${encodeURIComponent(location.owner)}/` +
    `${encodeURIComponent(location.repository)}/${encodeURIComponent(location.ref)}/${encodePath(remotePath)}`
  );
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
