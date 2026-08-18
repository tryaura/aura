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
const EMBEDDED_ASSET_ROOT = "/$bunfs/root/";

/** Whether `path` addresses a file embedded in a compiled single-file executable. */
export function isEmbeddedAssetPath(path: string): boolean {
  return path.startsWith(EMBEDDED_ASSET_PREFIX);
}

/**
 * Lists one virtual directory from Bun's flat embedded-file index.
 *
 * Bun exposes embedded files to `stat` and `readFile`, but it does not materialize their parent
 * directories for `stat` or `readdir`. Directory-backed plugin content therefore needs the index
 * to synthesize exactly the immediate children the filesystem would have returned.
 */
export function embeddedDirectoryEntries(path: string): readonly string[] | undefined {
  if (!path.startsWith(EMBEDDED_ASSET_ROOT)) {
    return undefined;
  }

  const relative = path.slice(EMBEDDED_ASSET_ROOT.length).replace(/\/+$/u, "");
  const prefix = relative.length === 0 ? "" : `${relative}/`;
  const entries = new Set<string>();
  for (const name of embeddedFileNames()) {
    if (!name.startsWith(prefix)) {
      continue;
    }
    const child = name.slice(prefix.length).split("/", 1)[0];
    if (child !== undefined && child.length > 0) {
      entries.add(child);
    }
  }
  return entries.size === 0 ? undefined : [...entries].sort();
}

function embeddedFileNames(): readonly string[] {
  const runtime: unknown = Reflect.get(globalThis, "Bun");
  if (!isRecord(runtime)) {
    return [];
  }
  const files = runtime["embeddedFiles"];
  if (!Array.isArray(files)) {
    return [];
  }
  return files.flatMap((file): readonly string[] => {
    if (!isRecord(file)) {
      return [];
    }
    const name = file["name"];
    return typeof name === "string" ? [name] : [];
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}
