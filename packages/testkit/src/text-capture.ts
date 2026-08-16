import { PassThrough } from "node:stream";

export interface TextCapture {
  readonly read: () => string;
  readonly stream: PassThrough;
}

/** A writable stream that accumulates everything written to it as text. */
export function createTextCapture(): TextCapture {
  const chunks: string[] = [];
  const stream = new PassThrough();
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    chunks.push(chunk);
  });
  return { read: () => chunks.join(""), stream };
}
