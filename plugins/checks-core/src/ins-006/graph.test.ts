import type { InstructionDocument, InstructionLink } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { findDepthOverflows } from "./depth.js";
import {
  buildInstructionGraph,
  findInstructionCycles,
  instructionGraphFor,
  reachableInstructionPaths,
} from "./graph.js";

describe("instruction link graph", () => {
  it("finds self, two-node, and three-node cycles with canonical paths", () => {
    const graph = buildInstructionGraph([
      document("/self.md", [link("/self.md")]),
      document("/b.md", [link("/a.md")]),
      document("/a.md", [link("/b.md")]),
      document("/z.md", [link("/x.md")]),
      document("/x.md", [link("/y.md")]),
      document("/y.md", [link("/z.md")]),
    ]);

    expect(findInstructionCycles(graph)).toEqual([
      ["/a.md", "/b.md", "/a.md"],
      ["/self.md", "/self.md"],
      ["/x.md", "/y.md", "/z.md", "/x.md"],
    ]);
  });

  it("deduplicates repeated observations and ignores invalid or unmodeled edges", () => {
    const first = document("/a.md", [
      link("/b.md"),
      link("/gone.md", false),
      link("/exists-but-unmodeled.md"),
    ]);
    const graph = buildInstructionGraph([
      first,
      { ...first, sourceId: "another-adapter" },
      document("/b.md", [link("/a.md")]),
      document("/disconnected.md", []),
    ]);

    expect(graph.edges.get("/a.md")).toEqual(["/b.md"]);
    expect(findInstructionCycles(graph)).toEqual([["/a.md", "/b.md", "/a.md"]]);
  });

  it("can exclude inert import edges without removing other link mechanisms", () => {
    const graph = buildInstructionGraph(
      [
        document("/a.md", [link("/b.md"), { kind: "symlink", targetPath: "/c.md", valid: true }]),
        document("/b.md", [link("/a.md")]),
        document("/c.md", []),
      ],
      { excludedImportSources: new Set(["/a.md"]) },
    );

    expect(graph.edges.get("/a.md")).toEqual(["/c.md"]);
    expect(findInstructionCycles(graph)).toEqual([]);
  });

  it("allows exactly five hops and reports the first six-hop chain", () => {
    const five = chain(5);
    const fiveGraph = buildInstructionGraph(five);
    expect(findDepthOverflows(fiveGraph, ["/0.md"], 5)).toEqual([]);

    const six = chain(6);
    const sixGraph = buildInstructionGraph(six);
    expect(findDepthOverflows(sixGraph, ["/0.md", "/1.md"], 5)).toEqual([
      {
        paths: ["/0.md", "/1.md", "/2.md", "/3.md", "/4.md", "/5.md", "/6.md"],
        rootPath: "/0.md",
      },
    ]);
  });

  /**
   * `/c.md` is first reached through `/a.md`, where its own edge back to `/a.md` is skipped for
   * already being on the path. Remembering that visit as clean would hide the overflow waiting
   * behind that edge when `/c.md` is reached again through `/b.md`.
   */
  it("re-explores a node whose earlier visit depended on the route taken", () => {
    const graph = buildInstructionGraph([
      document("/root.md", [link("/a.md"), link("/b.md")]),
      document("/a.md", [link("/c.md"), link("/d.md")]),
      document("/b.md", [link("/c.md")]),
      document("/c.md", [link("/a.md")]),
      document("/d.md", [link("/e.md")]),
      document("/e.md", []),
    ]);

    expect(findDepthOverflows(graph, ["/root.md"], 3)).toEqual([
      { paths: ["/root.md", "/b.md", "/c.md", "/a.md", "/d.md"], rootPath: "/root.md" },
    ]);
  });

  it("does not mistake cycles or disconnected components for depth overflow", () => {
    const graph = buildInstructionGraph([
      document("/a.md", [link("/b.md")]),
      document("/b.md", [link("/a.md")]),
      document("/elsewhere.md", []),
    ]);

    expect(findDepthOverflows(graph, ["/a.md", "/elsewhere.md"], 1)).toEqual([]);
  });

  it("walks reachable paths once across cycles, duplicate routes, and invalid edges", () => {
    const graph = buildInstructionGraph([
      document("/root.md", [link("/a.md"), link("/b.md"), link("/gone.md", false)]),
      document("/a.md", [link("/shared.md")]),
      document("/b.md", [link("/shared.md")]),
      document("/shared.md", [link("/root.md")]),
      document("/disconnected.md", []),
    ]);

    expect(reachableInstructionPaths(graph, ["/root.md", "/root.md"])).toEqual([
      "/a.md",
      "/b.md",
      "/root.md",
      "/shared.md",
    ]);
  });

  it("stops reachability at the configured hop boundary", () => {
    const graph = buildInstructionGraph(chain(3));

    expect(reachableInstructionPaths(graph, ["/0.md"], { maximumHops: 2 })).toEqual([
      "/0.md",
      "/1.md",
      "/2.md",
    ]);
  });

  it("treats an excluded document as absent, along with everything only it reaches", () => {
    const graph = buildInstructionGraph([
      document("/root.md", [link("/gate.md"), link("/plain.md")]),
      document("/gate.md", [link("/behind.md")]),
      document("/behind.md", []),
      document("/plain.md", []),
    ]);
    const excluded = new Set(["/gate.md"]);

    expect(reachableInstructionPaths(graph, ["/root.md"], { excluded })).toEqual([
      "/plain.md",
      "/root.md",
    ]);
    expect(reachableInstructionPaths(graph, ["/root.md", "/gate.md"], { excluded })).toEqual([
      "/plain.md",
      "/root.md",
    ]);
  });

  it("hands the same graph to every check reading one document list", () => {
    const documents = [document("/root.md", [link("/a.md")]), document("/a.md", [])];

    expect(instructionGraphFor(documents)).toBe(instructionGraphFor(documents));
    expect(instructionGraphFor(documents)).not.toBe(instructionGraphFor([...documents]));
    expect(instructionGraphFor(documents).edges).toEqual(buildInstructionGraph(documents).edges);
  });
});

function chain(hops: number): readonly InstructionDocument[] {
  return Array.from({ length: hops + 1 }, (_value, index) =>
    document(`/${String(index)}.md`, index === hops ? [] : [link(`/${String(index + 1)}.md`)]),
  );
}

function document(path: string, links: readonly InstructionLink[]): InstructionDocument {
  return { content: "", links, path, scope: "global", sourceId: `test:${path}` };
}

function link(targetPath: string, valid = true): InstructionLink {
  return { kind: "import", targetPath, valid };
}
