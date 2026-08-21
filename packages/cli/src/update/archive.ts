import { createReadStream } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { createGunzip } from "node:zlib";

import { isZeroBlock, parseTarHeader, TAR_BLOCK_BYTES } from "./tar-header.js";

/** Why an archive produced no staged files. */
export type ArchiveFailure =
  /** The stream was not a readable gzip tar, or drifted out of block alignment. */
  | "unreadable-archive"
  /** The archive carried something other than exactly the expected files. */
  | "unexpected-entry"
  /** The extracted bytes exceeded the bound, which a compression bomb is how you reach. */
  | "too-large"
  /** The archive read cleanly but never contained the executable. */
  | "missing-executable";

export interface ArchiveRequest {
  readonly archivePath: string;
  /** Entry name to destination path. An entry not named here fails the whole extraction. */
  readonly entries: Readonly<Record<string, string>>;
  readonly maxBytes: number;
  /** The entry the archive is worthless without. */
  readonly requiredEntry: string;
}

/**
 * Extracts the expected files from a gzip tar, and refuses everything else.
 *
 * Allow-listed by name rather than filtered after the fact: the extractor never creates a path the
 * caller did not name, so no header field — however hostile — can decide where a byte lands.
 */
export async function extractArchive(request: ArchiveRequest): Promise<ArchiveFailure | undefined> {
  const extractor = new TarExtractor(request);
  try {
    for await (const chunk of createReadStream(request.archivePath).pipe(createGunzip())) {
      if (!(chunk instanceof Uint8Array)) {
        return "unreadable-archive";
      }
      extractor.push(chunk);
      await extractor.drain();
      if (extractor.failure !== undefined) {
        return extractor.failure;
      }
    }
  } catch {
    return "unreadable-archive";
  } finally {
    await extractor.close();
  }
  return (
    extractor.failure ??
    (extractor.extracted(request.requiredEntry) ? undefined : "missing-executable")
  );
}

/** A tar reader that consumes a byte stream one 512-byte block at a time. */
class TarExtractor {
  failure: ArchiveFailure | undefined;

  readonly #request: ArchiveRequest;
  readonly #seen = new Set<string>();
  #chunks: Uint8Array[] = [];
  #queued = 0;
  #state: "body" | "header" | "padding" = "header";
  #remaining = 0;
  #padding = 0;
  #sink: FileHandle | undefined;
  #written = 0;
  #zeroBlocks = 0;
  #done = false;

  constructor(request: ArchiveRequest) {
    this.#request = request;
  }

  push(chunk: Uint8Array): void {
    this.#chunks.push(chunk);
    this.#queued += chunk.byteLength;
  }

  extracted(name: string): boolean {
    return this.#seen.has(name);
  }

  /** Consumes as much of the queue as the current state allows, then waits for more bytes. */
  async drain(): Promise<void> {
    while (this.failure === undefined && !this.#done) {
      const advanced =
        this.#state === "header"
          ? await this.#readHeader()
          : this.#state === "body"
            ? await this.#readBody()
            : await this.#endEntry();
      if (!advanced) {
        return;
      }
    }
  }

  async close(): Promise<void> {
    const sink = this.#sink;
    this.#sink = undefined;
    this.#chunks = [];
    this.#queued = 0;
    try {
      await sink?.close();
    } catch {
      // A handle that cannot be closed has already failed the extraction it belonged to.
    }
  }

  async #readHeader(): Promise<boolean> {
    const block = this.#take(TAR_BLOCK_BYTES);
    if (block === undefined) {
      return false;
    }
    if (isZeroBlock(block)) {
      this.#zeroBlocks += 1;
      this.#done = this.#zeroBlocks === 2;
      return true;
    }
    this.#zeroBlocks = 0;
    const entry = parseTarHeader(block);
    if (entry === undefined) {
      this.failure = "unexpected-entry";
      return false;
    }
    return await this.#openEntry(entry.name, entry.size);
  }

  async #openEntry(name: string, size: number): Promise<boolean> {
    const destination = this.#request.entries[name];
    if (destination === undefined || this.#seen.has(name)) {
      this.failure = "unexpected-entry";
      return false;
    }
    this.#written += size;
    if (this.#written > this.#request.maxBytes) {
      this.failure = "too-large";
      return false;
    }
    this.#seen.add(name);
    this.#sink = await open(destination, "wx", 0o600);
    this.#remaining = size;
    this.#padding = (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
    this.#state = size > 0 ? "body" : "padding";
    return true;
  }

  async #readBody(): Promise<boolean> {
    const count = Math.min(this.#remaining, this.#queued);
    const bytes = count === 0 ? undefined : this.#take(count);
    if (bytes === undefined) {
      return false;
    }
    await this.#sink?.write(bytes);
    this.#remaining -= count;
    if (this.#remaining === 0) {
      this.#state = "padding";
    }
    return true;
  }

  async #endEntry(): Promise<boolean> {
    if (this.#padding > 0) {
      if (this.#take(this.#padding) === undefined) {
        return false;
      }
      this.#padding = 0;
    }
    const sink = this.#sink;
    this.#sink = undefined;
    await sink?.sync();
    await sink?.close();
    this.#state = "header";
    return true;
  }

  /** Exactly `count` bytes off the front of the queue, or `undefined` until they have arrived. */
  #take(count: number): Uint8Array | undefined {
    if (this.#queued < count) {
      return undefined;
    }
    const out = new Uint8Array(count);
    let offset = 0;
    while (offset < count) {
      const chunk = this.#chunks[0];
      if (chunk === undefined) {
        return undefined;
      }
      const needed = count - offset;
      if (chunk.byteLength <= needed) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
        this.#chunks.shift();
      } else {
        out.set(chunk.subarray(0, needed), offset);
        offset += needed;
        this.#chunks[0] = chunk.subarray(needed);
      }
    }
    this.#queued -= count;
    return out;
  }
}
