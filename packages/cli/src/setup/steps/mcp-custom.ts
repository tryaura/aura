import {
  parseMcpServerDefinition,
  type McpDefinitionError,
  type McpServerDefinition,
} from "@tryaura/aura-sdk";

import { safe } from "../../safe-text.js";
import { SETUP_ABORTED, SETUP_BACK, type SetupStepContext } from "../types.js";
import {
  selectedValues,
  type WizardAnswer,
  type WizardIo,
  type WizardQuestion,
} from "../wizard-types.js";
import type { McpStepControl } from "./mcp-step-types.js";

export async function editCustomTransport(
  seed: McpServerDefinition | undefined,
  io: WizardIo,
  context: SetupStepContext,
): Promise<McpServerDefinition | McpStepControl> {
  const selectedType = seed?.type ?? "stdio";
  const typeResult = await io.ask(
    [
      {
        id: "mcp-transport-type",
        initial: [selectedType],
        kind: "select",
        label: "Transport",
        options: [
          { label: "Command (stdio)", value: "stdio" },
          { label: "Remote URL (HTTP)", value: "http" },
        ],
        prompt: "How does this custom MCP server run?",
      },
    ],
    context.flow,
  );
  if (typeResult === "aborted") {
    return SETUP_ABORTED;
  }
  if (typeResult === "back") {
    return SETUP_BACK;
  }
  return selectedValues(typeResult["mcp-transport-type"])[0] === "http"
    ? editHttpTransport(seed?.type === "http" ? seed : undefined, io)
    : editStdioTransport(seed?.type === "stdio" ? seed : undefined, io);
}

// fallow-ignore-next-line complexity -- preserves field drafts across every validation branch.
async function editStdioTransport(
  seed: Extract<McpServerDefinition, { readonly type: "stdio" }> | undefined,
  io: WizardIo,
): Promise<McpServerDefinition | McpStepControl> {
  let command = seed?.command ?? "";
  let args = JSON.stringify(seed?.args ?? []);
  let env = JSON.stringify(seed?.env ?? []);
  const initial = { args, command, env };
  for (;;) {
    const result = await io.ask([
      textQuestion("mcp-command", "Command", "Executable command", command),
      textQuestion("mcp-args", "Arguments", "Arguments as a JSON array", args),
      textQuestion("mcp-env", "Environment", "Environment names as a JSON array", env),
    ]);
    if (result === "aborted") {
      return SETUP_ABORTED;
    }
    if (result === "back") {
      return SETUP_BACK;
    }
    command = answerText(result["mcp-command"]);
    args = answerText(result["mcp-args"]);
    env = answerText(result["mcp-env"]);
    if (
      seed !== undefined &&
      command === initial.command &&
      args === initial.args &&
      env === initial.env
    ) {
      return seed;
    }
    const parsedArgs = parseJsonField(args);
    const parsedEnv = parseJsonField(env);
    if (parsedArgs.status === "invalid" || parsedEnv.status === "invalid") {
      io.note(
        `Custom MCP transport ${parsedArgs.status === "invalid" ? "$.args" : "$.env"} must contain valid JSON, such as ["--serve"].`,
      );
      continue;
    }
    const parsed = parseMcpServerDefinition({
      args: parsedArgs.value,
      command,
      env: parsedEnv.value,
      type: "stdio",
    });
    if ("error" in parsed) {
      io.note(rejection(parsed.error));
      continue;
    }
    return parsed.value;
  }
}

// fallow-ignore-next-line complexity -- preserves field drafts across every validation branch.
async function editHttpTransport(
  seed: Extract<McpServerDefinition, { readonly type: "http" }> | undefined,
  io: WizardIo,
): Promise<McpServerDefinition | McpStepControl> {
  let url = seed?.url ?? "";
  let headers = JSON.stringify(seed?.headers ?? {});
  const initial = { headers, url };
  for (;;) {
    const result = await io.ask([
      textQuestion("mcp-url", "URL", "Remote HTTP(S) URL", url),
      textQuestion("mcp-headers", "Headers", "Headers as a JSON object", headers),
    ]);
    if (result === "aborted") {
      return SETUP_ABORTED;
    }
    if (result === "back") {
      return SETUP_BACK;
    }
    url = answerText(result["mcp-url"]);
    headers = answerText(result["mcp-headers"]);
    if (seed !== undefined && url === initial.url && headers === initial.headers) {
      return seed;
    }
    const parsedHeaders = parseJsonField(headers);
    if (parsedHeaders.status === "invalid") {
      io.note(
        'Custom MCP transport $.headers must contain valid JSON, such as {"Authorization":"Bearer ${TOKEN}"}.',
      );
      continue;
    }
    const parsed = parseMcpServerDefinition({
      headers: parsedHeaders.value,
      type: "http",
      url,
    });
    if ("error" in parsed) {
      io.note(rejection(parsed.error));
      continue;
    }
    return parsed.value;
  }
}

/**
 * States which field was refused and why, without echoing what was typed into it.
 *
 * The reason is Aura's own sentence — the parser's messages are fixed strings, and the one value
 * any of them interpolates is an environment-variable name already bounded to `[A-Z0-9_]`. The
 * path is not: it carries the header name the user supplied, which is why it is collapsed to the
 * field it belongs to before it reaches the terminal.
 */
function rejection(error: McpDefinitionError): string {
  return `Custom MCP transport ${safeValidationPath(error.path)} ${safe(error.message)}.`;
}

function safeValidationPath(path: string): string {
  const known = path.match(/^\$\.(?:args|env)(?:\[\d+\])?$/u);
  if (known !== null) {
    return known[0];
  }
  for (const field of ["command", "headers", "type", "url"]) {
    if (path === `$.${field}` || path.startsWith(`$.${field}.`)) {
      return `$.${field}`;
    }
  }
  return "$";
}

function parseJsonField(
  text: string,
): { readonly status: "invalid" } | { readonly status: "ready"; readonly value: unknown } {
  try {
    return { status: "ready", value: JSON.parse(text) };
  } catch {
    return { status: "invalid" };
  }
}

export function textQuestion(
  id: string,
  label: string,
  prompt: string,
  initialText: string,
): WizardQuestion {
  return {
    freeText: true,
    id,
    initialText,
    kind: "select",
    label,
    options: [],
    prompt,
  };
}

export function answerText(answer: WizardAnswer | undefined): string {
  return answer?.kind === "text" ? answer.text : "";
}
