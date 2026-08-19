import { Buffer } from "node:buffer";
import type { FileHandle } from "node:fs/promises";

/** Reads at most `maxBytes` from the start of an already-open file. */
export async function readFileHandlePrefix(file: FileHandle, maxBytes: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(maxBytes);
  let offset = 0;
  while (offset < buffer.length) {
    const result = await file.read(buffer, offset, buffer.length - offset, offset);
    if (result.bytesRead === 0) {
      break;
    }
    offset += result.bytesRead;
  }
  return buffer.subarray(0, offset);
}
