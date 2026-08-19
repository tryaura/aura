import { describe, expect, it } from "vitest";

import { auditWorkflowSource } from "./verify-workflows.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("GitHub Actions workflow policy", () => {
  it("accepts SHA-pinned external actions and repository-local actions", () => {
    const source = `name: Test
on: push
permissions:
  contents: read
jobs:
  test:
    steps:
      - uses: actions/checkout@${SHA} # v1.2.3
      - uses: ./.github/actions/local
`;

    expect(auditWorkflowSource(source, "workflow.yml")).toEqual([]);
  });

  it.each(["actions/checkout@v6", "actions/checkout@main"])(
    "rejects mutable external action ref %s",
    (reference) => {
      const source = `permissions: read-all
jobs:
  test:
    uses: ${reference}
`;

      expect(auditWorkflowSource(source, "workflow.yml")).toEqual([
        `workflow.yml:4: external action "${reference}" must use a full 40-character lowercase commit SHA`,
      ]);
    },
  );

  it("rejects job-level permissions when root-level permissions are absent", () => {
    const source = `jobs:
  test:
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@${SHA}
`;

    expect(auditWorkflowSource(source, "workflow.yml")).toEqual([
      "workflow.yml:1: workflow must declare root-level permissions",
    ]);
  });
});
