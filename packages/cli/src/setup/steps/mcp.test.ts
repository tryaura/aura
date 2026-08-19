import { describe, expect, it } from "vitest";

import { createScriptedWizardIo } from "../wizard-scripted.js";
import type { WizardAnswers } from "../wizard-types.js";
import { mcpStep } from "./mcp.js";
import {
  answer,
  context,
  definition,
  generalAnswers,
  serverNames,
  textAnswers,
} from "./mcp.test-support.js";

describe("mcpStep", () => {
  it("uses catalog serverName defaults and disables incompatible applications", async () => {
    const sentry = definition("official/sentry", "Sentry", "sentry", ["claude-code", "cursor"]);
    const io = createScriptedWizardIo({
      forms: [
        answer("mcp-servers", ["catalog:official/sentry"]),
        {
          "mcp-apps": { kind: "options", values: ["claude-code"] },
        },
      ],
    });
    const result = await mcpStep.gather(context([sentry]), io);

    expect(result).toMatchObject({
      mcp: {
        servers: [
          {
            apps: ["claude-code"],
            catalogId: "official/sentry",
            name: "sentry",
            scope: "global",
          },
        ],
      },
    });
  });

  it("requires explicit confirmation before overriding a required server", async () => {
    const github = definition("official/github", "GitHub", "github");
    const io = createScriptedWizardIo({
      confirmations: ["declined", "accepted"],
      forms: [answer("mcp-servers", []), answer("mcp-servers", [])],
    });
    const result = await mcpStep.gather(context([github], ["official/github"]), io);

    expect(result).toEqual({
      mcp: { overriddenRequiredIds: ["official/github"], servers: [] },
    });
  });

  it("preserves a recorded required-server override without prompting again", async () => {
    const github = definition("official/github", "GitHub", "github");
    const io = createScriptedWizardIo({ confirmations: ["aborted"] });

    const result = await mcpStep.gather(
      context([github], ["official/github"], {
        overriddenRequiredIds: ["official/github"],
      }),
      io,
    );

    expect(result).toEqual({
      mcp: { overriddenRequiredIds: ["official/github"], servers: [] },
    });
  });

  it("clears a recorded override when the required server is selected", async () => {
    const github = definition("official/github", "GitHub", "github");
    const io = createScriptedWizardIo({
      forms: [answer("mcp-servers", ["catalog:official/github"]), {}],
    });

    const result = await mcpStep.gather(
      context([github], ["official/github"], {
        overriddenRequiredIds: ["official/github"],
      }),
      io,
    );

    expect(result).toMatchObject({
      mcp: { overriddenRequiredIds: [], servers: [{ catalogId: "official/github" }] },
    });
  });

  it("captures multiple custom transports without ever echoing rejected credential bytes", async () => {
    const credential = "sk-live-secret-value";
    const forms: WizardAnswers[] = [
      answer("mcp-servers", ["mcp:add-custom"]),
      answer("mcp-transport-type", ["stdio"]),
      textAnswers({ "mcp-command": credential, "mcp-args": "[]", "mcp-env": "[]" }),
      textAnswers({
        "mcp-command": "docs-mcp",
        "mcp-args": '["--serve"]',
        "mcp-env": '["DOCS_TOKEN"]',
      }),
      answer("mcp-servers", ["custom:0", "mcp:add-custom"]),
      answer("mcp-transport-type", ["http"]),
      textAnswers({
        "mcp-headers": '{"Authorization":"Bearer ${SEARCH_TOKEN}"}',
        "mcp-url": "https://example.test/mcp",
      }),
      answer("mcp-servers", ["custom:0", "custom:1"]),
      generalAnswers("docs", ["claude-code"]),
      generalAnswers("search", ["cursor"]),
    ];
    const io = createScriptedWizardIo({ forms });
    const result = await mcpStep.gather(context([]), io);

    expect(result).toMatchObject({
      mcp: {
        servers: [
          {
            name: "docs",
            transport: {
              args: ["--serve"],
              command: "docs-mcp",
              env: ["DOCS_TOKEN"],
              type: "stdio",
            },
          },
          {
            name: "search",
            transport: {
              headers: { Authorization: "Bearer ${SEARCH_TOKEN}" },
              type: "http",
              url: "https://example.test/mcp",
            },
          },
        ],
      },
    });
    expect(io.notes.join("\n")).not.toContain(credential);
    // The reason, so the retry is a correction rather than a guess — and only the reason.
    expect(io.notes.join("\n")).toContain(
      "Custom MCP transport $.command must not contain a credential literal.",
    );
  });

  it("never first-configures a preset-required server for a run answering its own questions", async () => {
    const github = definition("official/github", "GitHub", "github");
    const io = createScriptedWizardIo();

    const result = await mcpStep.gather(
      context([github], ["official/github"], { interactive: false }),
      io,
    );

    // Unselected and unoverridden: the planner turns that into a blocker naming the interactive
    // run, where a person can see which endpoint is about to receive a credential.
    expect(result).toEqual({ mcp: { overriddenRequiredIds: [], servers: [] } });
  });

  it("names added custom servers so two of them can be recorded together", async () => {
    const io = createScriptedWizardIo({
      forms: [
        answer("mcp-servers", ["mcp:add-custom"]),
        answer("mcp-transport-type", ["stdio"]),
        textAnswers({ "mcp-args": "[]", "mcp-command": "docs-mcp", "mcp-env": "[]" }),
        answer("mcp-servers", ["custom:0", "mcp:add-custom"]),
        answer("mcp-transport-type", ["stdio"]),
        textAnswers({ "mcp-args": "[]", "mcp-command": "search-mcp", "mcp-env": "[]" }),
        answer("mcp-servers", ["custom:0", "custom:1"]),
      ],
    });

    const result = await mcpStep.gather(context([]), io);

    expect(serverNames(result)).toEqual(["custom", "custom-2"]);
  });

  it("refuses a name another selected server already claims for the same application", async () => {
    const github = definition("official/github", "GitHub", "github");
    const sentry = definition("official/sentry", "Sentry", "sentry");
    const io = createScriptedWizardIo({
      forms: [
        answer("mcp-servers", ["catalog:official/github", "catalog:official/sentry"]),
        generalAnswers("shared", ["claude-code"]),
        generalAnswers("shared", ["claude-code"]),
        generalAnswers("separate", ["claude-code"]),
      ],
    });

    const result = await mcpStep.gather(context([github, sentry]), io);

    expect(serverNames(result)).toEqual(["shared", "separate"]);
    expect(io.notes.join("\n")).toContain("already configured at global scope");
  });

  it("keeps the answers of this pass when a later form goes back to the picker", async () => {
    const github = definition("official/github", "GitHub", "github");
    const sentry = definition("official/sentry", "Sentry", "sentry");
    const both = ["catalog:official/github", "catalog:official/sentry"];
    const io = createScriptedWizardIo({
      forms: [
        answer("mcp-servers", both),
        generalAnswers("renamed", ["claude-code"]),
        "back",
        answer("mcp-servers", both),
        // Every field defaulted: the name below can only come from the answer given before ←.
        {},
        generalAnswers("sentry", ["cursor"]),
      ],
    });

    const result = await mcpStep.gather(context([github, sentry]), io);

    expect(serverNames(result)).toEqual(["renamed", "sentry"]);
  });

  it("lets a custom transport be corrected after backing out of its own form", async () => {
    const io = createScriptedWizardIo({
      forms: [
        answer("mcp-servers", ["mcp:add-custom"]),
        answer("mcp-transport-type", ["stdio"]),
        textAnswers({ "mcp-args": "[]", "mcp-command": "typo-mcp", "mcp-env": "[]" }),
        answer("mcp-servers", ["custom:0"]),
        "back",
        answer("mcp-servers", ["custom:0"]),
        answer("mcp-transport-type", ["stdio"]),
        textAnswers({ "mcp-args": "[]", "mcp-command": "docs-mcp", "mcp-env": "[]" }),
      ],
    });

    const result = await mcpStep.gather(context([]), io);

    expect(result).toMatchObject({
      mcp: { servers: [{ transport: { command: "docs-mcp", type: "stdio" } }] },
    });
  });
});
