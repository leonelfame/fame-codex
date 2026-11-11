import { randomUUID } from "node:crypto";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { z } from "zod";
import { AIPASS_PROMPT_TOKEN_BUDGET } from "../../aipass-config";
import { estimateTokens } from "../../lib/token-estimate";
import { namespacedToolName, type AdapterEvent, type CodexParsedRequest } from "../../types";

const objectArguments = z.record(z.string(), z.unknown());
const frameSchema = z.object({
  calls: z.array(z.object({ name: z.string().min(1), arguments: z.union([objectArguments, z.string()]) }).strict()).min(1),
}).strict();

export class AiPassError extends Error {
  constructor(message: string, readonly code = "aipass_protocol_error", readonly status = 502) {
    super(message);
  }
}

function unsupported(message: string): never {
  throw new AiPassError(message, "aipass_unsupported_request", 400);
}

function rejectOpaque(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach(rejectOpaque);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    // Tool schemas and argument objects are user data, not provider envelopes.
    if (["tools", "parameters", "arguments"].includes(key)) continue;
    if (["encrypted_content", "redacted", "signature", "thoughtSignature"].includes(key) && entry) {
      unsupported("AI Pass cannot replay opaque or signed history");
    }
    if (key === "type" && typeof entry === "string"
      && /image|audio|video|input_file|encrypted|compaction/.test(entry)) {
      unsupported(`AI Pass cannot preserve ${entry}`);
    }
    rejectOpaque(entry);
  }
}

export function prepareTurn(parsed: CodexParsedRequest) {
  if (parsed._compactionRequest || parsed._opaqueMultiAgentV2Payload) unsupported("AI Pass does not support compaction or opaque delegation");
  if (parsed.previousResponseId && !parsed._replayPrefixLen) unsupported("AI Pass requires expanded previous_response_id history");
  rejectOpaque(parsed._rawBody);
  for (const [key, value] of Object.entries(parsed.options)) {
    if (value !== undefined && !["toolChoice", "parallelToolCalls", "hideThinkingSummary", "reasoning", "promptCacheKey"].includes(key)) {
      unsupported(`AI Pass cannot faithfully apply option ${key}`);
    }
  }
  for (const message of parsed.context.messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "image") unsupported("AI Pass image input is unsupported, including tool result images");
      if (part.type === "thinking" && (part.signature || part.redacted?.length)) unsupported("AI Pass cannot replay opaque reasoning");
      if (part.type === "toolCall" && part.thoughtSignature) unsupported("AI Pass cannot replay signed tool calls");
    }
  }
  const tools = parsed.context.tools ?? [];
  const byName = new Map(tools.map(tool => [namespacedToolName(tool.namespace, tool.name), tool]));
  if (byName.size !== tools.length) unsupported("Duplicate or colliding tool wire names");
  // The Responses formatter chooses custom/search formatting by unqualified name.
  for (const tool of tools) {
    if (tool.freeform && tool.toolSearch) unsupported("A tool cannot be both freeform and tool_search");
    if (tools.some(other => other.name === tool.name
      && (!!other.freeform !== !!tool.freeform || !!other.toolSearch !== !!tool.toolSearch))) {
      unsupported("Ambiguous tool formatting for the same unqualified name");
    }
  }
  const choice = parsed.options.toolChoice ?? "auto";
  let allowed = new Set(byName.keys());
  let required = choice === "required";
  if (choice === "none") allowed.clear();
  if (typeof choice === "object") {
    const names = "name" in choice ? [choice.name] : choice.allowedTools;
    for (const name of names) if (!byName.has(name)) unsupported(`Unknown toolChoice wire name: ${name}`);
    allowed = new Set(names);
    required = "name" in choice || choice.mode === "required";
  }
  if (required && !allowed.size) unsupported("Required toolChoice has no allowed tools");

  const ajv = new Ajv({ strict: false, allErrors: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
  addFormats(ajv);
  const validators = new Map(tools.filter(tool => !tool.freeform).map(tool => {
    try {
      return [namespacedToolName(tool.namespace, tool.name), ajv.compile(tool.parameters)] as const;
    } catch {
      return unsupported(`Invalid or unsupported argument schema for ${tool.name}`);
    }
  }));
  const nonce = randomUUID();
  const open = `<aipass-tools:${nonce}>`;
  const close = `</aipass-tools:${nonce}>`;
  const { reasoning: _reasoning, promptCacheKey: _promptCacheKey, ...promptOptions } = parsed.options;
  const prompt = [
    "EXPERIMENTAL CODEX WEB WRAPPER. The JSON below is the complete ordered Codex context, not just its latest message.",
    "Apply systemPrompt and developer instructions, preserve conversation roles, and use toolResult entries as results of earlier calls.",
    "Return an ordinary final answer as plain text. Do not wrap normal answers in JSON or a tool frame.",
    `To request tools, return ONLY ${open}{"calls":[{"name":"EXACT_WIRE_NAME","arguments":{}}]}${close}.`,
    "arguments must be a JSON object (or a string encoding a JSON object) satisfying the supplied tool parameters.",
    'For freeform tools use arguments:{"input":"exact unmodified freeform input"}. For toolSearch use its supplied JSON argument schema.',
    "Calls are requests for outer Codex to execute. Never pretend to execute them or fabricate their results.",
    `Allowed wire names: ${JSON.stringify([...allowed])}. Tool call required: ${required}. Parallel calls allowed: ${parsed.options.parallelToolCalls !== false}.`,
    "BEGIN_CODEX_CONTEXT_JSON",
    JSON.stringify({ ...parsed.context, tools: tools.map(tool => ({ ...tool, wireName: namespacedToolName(tool.namespace, tool.name) })), options: promptOptions }),
    "END_CODEX_CONTEXT_JSON",
  ].join("\n");
  const promptTokens = estimateTokens(prompt);
  if (promptTokens > AIPASS_PROMPT_TOKEN_BUDGET) {
    throw new AiPassError(
      `TH AI Pass local prompt budget exceeded: approximately ${promptTokens} tokens, limit ${AIPASS_PROMPT_TOKEN_BUDGET}. Reduce enabled tools or shorten the session. Upstream model limits may be lower.`,
      "aipass_prompt_budget_exceeded", 400,
    );
  }

  let buffer = "";
  let plain = false;
  const textEvents = (text: string, emit: (event: AdapterEvent) => void) => {
    if (text) emit({ type: "text_delta", text, phase: "final_answer" });
  };
  return {
    prompt,
    push(text: string, emit: (event: AdapterEvent) => void) {
      if (plain) return textEvents(text, emit);
      buffer += text;
      const start = buffer.trimStart();
      if (!open.startsWith(start) && !start.startsWith(open)) {
        if (start.startsWith("<aipass-tools:")) throw new AiPassError("Wrong tool frame nonce");
        if (!required) {
          plain = true;
          textEvents(buffer, emit);
          buffer = "";
        }
      }
    },
    finish(reason: "stop" | "length", emit: (event: AdapterEvent) => void) {
      const text = buffer.trim();
      if (text.startsWith(open)) {
        if (reason !== "stop" || !text.endsWith(close)) throw new AiPassError("Incomplete tool frame");
        const frame = frameSchema.parse(JSON.parse(text.slice(open.length, -close.length)));
        if (parsed.options.parallelToolCalls === false && frame.calls.length > 1) throw new AiPassError("Parallel tool calls were disabled");
        // Validate the whole batch before exposing any executable call.
        const calls = frame.calls.map(call => {
          const tool = byName.get(call.name);
          if (!tool || !allowed.has(call.name)) throw new AiPassError(`Disallowed tool: ${call.name}`);
          const args = objectArguments.parse(typeof call.arguments === "string" ? JSON.parse(call.arguments) : call.arguments);
          if (tool.freeform) z.object({ input: z.string() }).strict().parse(args);
          else if (!validators.get(call.name)?.(args)) throw new AiPassError(`Arguments violate schema for ${call.name}`);
          return { name: call.name, arguments: JSON.stringify(args), id: `call_${randomUUID().replaceAll("-", "")}` };
        });
        for (const call of calls) {
          emit({ type: "tool_call_start", id: call.id, name: call.name });
          emit({ type: "tool_call_delta", arguments: call.arguments });
          emit({ type: "tool_call_end" });
        }
        emit({ type: "done", stopReason: "tool_use", endTurn: false });
        return;
      }
      if (required) throw new AiPassError("Required tool call was not returned");
      if (text && (open.startsWith(text) || text.startsWith("<aipass-tools:"))) throw new AiPassError("Incomplete tool frame");
      textEvents(buffer, emit);
      if (reason === "length") emit({ type: "incomplete", reason: "max_output_tokens", retryable: false, endTurn: true });
      else emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  };
}
