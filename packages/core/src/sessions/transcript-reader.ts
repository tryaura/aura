import { open } from "node:fs/promises";

import type { FileHandle } from "node:fs/promises";

/** A bounded transcript stream plus the file size observed when it was opened. */
interface TranscriptLines {
  /** Whether the requested prefix was read without an I/O race or stream failure. */
  readonly completed?: (() => boolean) | undefined;
  readonly lines: AsyncIterable<string>;
  readonly size: number;
}

export type TranscriptReader = (
  path: string,
  maxBytes: number,
) => Promise<TranscriptLines | undefined>;

const READ_BUFFER_BYTES = 65_536;

/** Creates a filesystem reader that never buffers more than one JSONL record plus one chunk. */
export function createTranscriptReader(): TranscriptReader {
  return async (path, maxBytes) => {
    let file: FileHandle;
    try {
      file = await open(path, "r");
    } catch {
      return undefined;
    }

    try {
      const stats = await file.stat();
      if (!stats.isFile()) {
        await file.close();
        return undefined;
      }
      const status = { complete: false };
      return {
        completed: () => status.complete,
        lines: transcriptLines(
          file,
          Math.min(maxBytes, stats.size),
          stats.size <= maxBytes,
          status,
        ),
        size: stats.size,
      };
    } catch {
      await file.close().catch(() => undefined);
      return undefined;
    }
  };
}

async function* transcriptLines(
  file: FileHandle,
  bytesToRead: number,
  complete: boolean,
  status: { complete: boolean },
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let remaining = bytesToRead;
  let pending = "";
  let searchFrom = 0;
  try {
    while (remaining > 0) {
      const buffer = Buffer.allocUnsafe(Math.min(READ_BUFFER_BYTES, remaining));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      remaining -= bytesRead;
      pending += decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
      let newline = pending.indexOf("\n", searchFrom);
      while (newline !== -1) {
        yield pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      searchFrom = pending.length;
    }
    pending += decoder.decode();
    if (complete && pending !== "") {
      yield pending;
    }
    status.complete = remaining === 0;
  } catch {
    return;
  } finally {
    await file.close().catch(() => undefined);
  }
}
