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
      // The tar terminator is the end of the input this extractor owns. Stopping the pipeline here
      // prevents compressed trailing members from being decompressed and retained without bound.
      if (extractor.done) {
        break;
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
  #pending: string | undefined;
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

  get done(): boolean {
    return this.#done;
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
    this.#pending = undefined;
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
    this.#pending = name;
    this.#sink = await open(destination, "wx", 0o600);
    this.#remaining = size;
    this.#padding = (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
    this.#state = size > 0 ? "body" : "padding";
    return true;
  }

  /**
   * Writes body bytes straight out of the queue.
   *
   * Deliberately not routed through {@link TarExtractor.#take}: gathering a contiguous buffer first
   * would copy the whole executable an extra time on its way to disk, and nothing here needs the
   * bytes in hand. Only headers and padding, which are one block at a time, do.
   */
  async #readBody(): Promise<boolean> {
    const count = Math.min(this.#remaining, this.#queued);
    if (count === 0) {
      return false;
    }
    let written = 0;
    while (written < count) {
      const slice = this.#shift(count - written);
      if (slice === undefined) {
        return false;
      }
      written += slice.byteLength;
      await this.#sink?.write(slice);
    }
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
    // Recorded here rather than at the header: an entry counts as extracted once its bytes are on
    // disk, so a stream that ends mid-body fails the required-entry check instead of passing it.
    if (this.#pending !== undefined) {
      this.#seen.add(this.#pending);
      this.#pending = undefined;
    }
    this.#state = "header";
    return true;
  }

  /** Up to `limit` bytes off the front of the queue, without copying them. */
  #shift(limit: number): Uint8Array | undefined {
    const chunk = this.#chunks[0];
    if (chunk === undefined) {
      return undefined;
    }
    if (chunk.byteLength <= limit) {
      this.#chunks.shift();
      this.#queued -= chunk.byteLength;
      return chunk;
    }
    this.#chunks[0] = chunk.subarray(limit);
    this.#queued -= limit;
    return chunk.subarray(0, limit);
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
