import { describe, expect, it } from "vitest";

import { advanceMarkdownFence } from "./markdown-fence.js";

describe("CommonMark fence tracking", () => {
  it("opens on a run of three or more backticks or tildes", () => {
    expect(advanceMarkdownFence("``", undefined)).toBeUndefined();
    expect(advanceMarkdownFence("```", undefined)).toMatchObject({ character: "`", length: 3 });
    expect(advanceMarkdownFence("~~~~", undefined)).toMatchObject({ character: "~", length: 4 });
    expect(advanceMarkdownFence("   ```", undefined)).toMatchObject({ character: "`", length: 3 });
  });

  it("keeps a four-backtick fence open past a three-backtick line", () => {
    const opened = advanceMarkdownFence("````", undefined);
    expect(advanceMarkdownFence("```", opened)).toBe(opened);
    expect(advanceMarkdownFence("````", opened)).toBeUndefined();
    expect(advanceMarkdownFence("`````", advanceMarkdownFence("````", undefined))).toBeUndefined();
  });

  it("requires the closing run to match the opening character", () => {
    const opened = advanceMarkdownFence("```", undefined);
    expect(advanceMarkdownFence("~~~", opened)).toBe(opened);
  });

  it("treats a long-enough run with trailing text as fence content", () => {
    const opened = advanceMarkdownFence("```", undefined);
    expect(advanceMarkdownFence("```ts", opened)).toBe(opened);
    expect(advanceMarkdownFence("```   ", opened)).toBeUndefined();
  });
});
