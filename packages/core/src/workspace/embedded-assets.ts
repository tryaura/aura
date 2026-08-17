/**
 * The virtual filesystem root Bun mounts inside a `bun build --compile` executable.
 *
 * Everything the compiled binary carries — the bundled JavaScript and every `--loader .md:file`
 * asset — is addressed under this prefix at runtime. That filesystem answers `stat` and `readFile`
 * but not the `lstat` and positional `open`/`read` calls the ordinary reader prefers, which is the
 * only reason those substitutions exist in `reader-filesystem`.
 *
 * This is a Bun implementation detail rather than a documented API, and it is POSIX-spelled: Bun
 * mounts the same tree at `B:\~BUN\root` on Windows, which Aura does not recognise because it does
 * not ship a Windows binary. Keeping the constant here makes a Bun change a one-line edit.
 */
const EMBEDDED_ASSET_PREFIX = "/$bunfs/";

/** Whether `path` addresses a file embedded in a compiled single-file executable. */
export function isEmbeddedAssetPath(path: string): boolean {
  return path.startsWith(EMBEDDED_ASSET_PREFIX);
}
