import { afterEach, expect, test } from "bun:test";
import { createAiPassAdapter } from "../src/adapters/aipass";
import { buildResponseJSON } from "../src/bridge";
import { parseRequest } from "../src/responses/parser";
import { namespacedToolName, type AdapterEvent, type CodexParsedRequest } from "../src/types";
import { prepareTurn } from "../src/adapters/aipass/protocol";
import { AIPASS_PROMPT_TOKEN_BUDGET } from "../src/aipass-config";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.stop(true))); });

type Seen = { path: string; body: unknown; headers: Headers };
const record = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object fixture");
  return value;
};
function promptFrom(body: unknown): string {
  const value = record(body);
  if (!("messages" in value) || !Array.isArray(value.messages)) throw new Error("Expected messages");
  expect(value.messages).toHaveLength(1);
  const message: unknown = value.messages[0];
  const row = record(message);
  if (!("content" in row) || typeof row.content !== "string") throw new Error("Expected prompt");
  return row.content;
}
function frame(body: unknown, calls: unknown[]): string {
  const match = promptFrom(body).match(/AIPASS_TOOLS_([a-f0-9-]+)/);
  if (!match) throw new Error("Missing nonce");
  return `AIPASS_TOOLS_${match[1]}\n${JSON.stringify({ calls })}\nEND_AIPASS_TOOLS_${match[1]}`;
}
function chunks(text: string, finish = "stop"): string {
  return [
    `: keepalive\r\n\r\n`,
    ...[text.slice(0, 5), text.slice(5)].map(content => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\r\n\r\n`),
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}
function stream(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      // Exercise split JSON, UTF-8 characters, SSE fields and delimiters.
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}
function fixture(options: {
  chat?: (body: unknown, req: Request) => Response | Promise<Response>;
  hardened?: boolean;
  automaticRetries?: boolean;
} = {}) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body: unknown = req.method === "POST" ? await req.json() : undefined;
      seen.push({ path, body, headers: req.headers });
      if (path === "/health") return Response.json({
        ok: true, ...(options.hardened === false ? {} : { capabilities: { isolatedTurns: true, automaticRetries: options.automaticRetries ?? false } }),
      });
      if (path === "/v1/chat/isolated") return options.chat?.(body, req) ?? stream(chunks("\u0e2a\u0e27\u0e31\u0e2a\u0e14\u0e35 final answer"));
      return new Response("unexpected route", { status: 404 });
    },
  });
  servers.push(server);
  return { seen, bridgeUrl: server.url.origin };
}
function request(): CodexParsedRequest {
  return { modelId: "aipass/fixture", stream: true, options: {}, context: { messages: [{ role: "user", content: "last question", timestamp: 1 }] } };
}
async function run(bridgeUrl: string, parsed = request(), signal?: AbortSignal, thinking?: string[]) {
  const events: AdapterEvent[] = [];
  await createAiPassAdapter({ bridgeUrl, model: "fixture-model", thinking }).runTurn(parsed, {
    headers: new Headers({ authorization: "Bearer native-secret-fixture", "chatgpt-account-id": "private-fixture" }), abortSignal: signal,
  }, event => events.push(event));
  return events;
}
function finalText(events: AdapterEvent[]) {
  return events.filter(event => event.type === "text_delta").map(event => event.text).join("");
}

test("a first Codex turn with hundreds of tools fits the local budget without trimming context", () => {
  const parsed = request();
  parsed.context.tools = Array.from({ length: 457 }, (_, index) => ({
    name: `tool_${index}`, description: "Tool documentation with parameters and examples. ".repeat(30),
    parameters: { type: "object", properties: { input: { type: "string" } } },
  }));
  parsed.context.systemPrompt = ["Preserve these developer instructions."];
  const turn = prepareTurn(parsed);
  expect(turn.prompt.length).toBeGreaterThan(16384 * 3);
  expect(turn.prompt).toContain('"name":"tool_456"');
  expect(turn.prompt).toContain("Preserve these developer instructions.");
  expect(turn.prompt).toContain("last question");
});

test("the budget counts tokens in the outbound prompt and rejects oversized context explicitly", () => {
  const parsed = request();
  parsed._rawBody = { metadata: { unrelated: "x".repeat(100_000) } };
  expect(prepareTurn(parsed).prompt).not.toContain("unrelated");
  parsed.context.messages = [{ role: "user", content: "word ".repeat(AIPASS_PROMPT_TOKEN_BUDGET + 100), timestamp: 1 }];
  expect(() => prepareTurn(parsed)).toThrow("Reduce enabled tools or shorten the session");
});

test("upstream policy errors identify the refusal without exposing the echoed private prompt", async () => {
  const f = fixture({ chat: () => stream(`data: ${JSON.stringify({ error: { message: 'aipass returned 422 — {"code":"CHAT_RAI_VIOLATION","originalText":"PRIVATE_PROMPT"}' } })}\n\ndata: [DONE]\n\n`) });
  const events = await run(f.bridgeUrl);
  expect(events).toContainEqual(expect.objectContaining({ type: "error", code: "aipass_upstream_error", message: expect.stringContaining("CHAT_RAI_VIOLATION") }));
  expect(JSON.stringify(events)).not.toContain("PRIVATE_PROMPT");
});

test("retries a rejected multi-call frame before emitting any tool calls", async () => {
  let attempts = 0;
  const f = fixture({ chat: body => {
    attempts++;
    const call = { name: "read", arguments: { path: "file" } };
    return stream(chunks(frame(body, attempts === 1 ? [call, call] : [call])));
  } });
  const parsed = request();
  parsed.options.parallelToolCalls = false;
  parsed.context.tools = [{ name: "read", description: "Read a file", parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } } }];
  const events = await run(f.bridgeUrl, parsed);
  expect(attempts).toBe(2);
  expect(events.filter(event => event.type === "tool_call_start")).toHaveLength(1);
  expect(events.at(-1)).toEqual({ type: "done", stopReason: "tool_use", endTurn: false });
});

test("retries invalid frame JSON without executing the rejected frame", async () => {
  let attempts = 0;
  const f = fixture({ chat: body => {
    attempts++;
    const valid = frame(body, [{ name: "read", arguments: { path: "file" } }]);
    return stream(chunks(attempts === 1 ? valid.replace(/}\nEND_AIPASS_TOOLS_/, "}}\nEND_AIPASS_TOOLS_") : valid));
  } });
  const parsed = request();
  parsed.context.tools = [{ name: "read", description: "Read a file", parameters: { type: "object" } }];
  const events = await run(f.bridgeUrl, parsed);
  expect(attempts).toBe(2);
  expect(events.filter(event => event.type === "tool_call_start")).toHaveLength(1);
});

test("stops after three invalid tool frames without emitting a tool call", async () => {
  let attempts = 0;
  const f = fixture({ chat: body => {
    attempts++;
    const valid = frame(body, [{ name: "read", arguments: { path: "file" } }]);
    return stream(chunks(valid.replace(/}\nEND_AIPASS_TOOLS_/, "}}\nEND_AIPASS_TOOLS_")));
  } });
  const parsed = request();
  parsed.context.tools = [{ name: "read", description: "Read a file", parameters: { type: "object" } }];
  const events = await run(f.bridgeUrl, parsed);
  expect(attempts).toBe(3);
  expect(events.filter(event => event.type === "tool_call_start")).toHaveLength(0);
  expect(events.at(-1)).toMatchObject({ type: "error", message: "AI Pass model returned invalid tool frame JSON" });
});

test("reports extension timeouts without exposing upstream error text", async () => {
  const f = fixture({ chat: () => Response.json({ error: { message: "timed out waiting for the extension PRIVATE_PROMPT" } }, { status: 502 }) });
  const events = await run(f.bridgeUrl);
  expect(events).toContainEqual(expect.objectContaining({ type: "error", message: expect.stringContaining("timed out waiting for the browser extension") }));
  expect(JSON.stringify(events)).not.toContain("PRIVATE_PROMPT");
});

test("serializes the entire context into one user prompt, uses isolated turns and never forwards auth or fabricates usage", async () => {
  const f = fixture();
  const parsed = request();
  parsed.context = {
    systemPrompt: ["system one", "system two"],
    tools: [{ name: "read", namespace: "mcp__local", description: "read schema", parameters: { type: "object" } }],
    messages: [
      { role: "developer", content: "developer instruction", timestamp: 1 },
      { role: "user", content: "first user", timestamp: 2 },
      { role: "assistant", content: [{ type: "thinking", thinking: "readable prior thought" }, { type: "toolCall", id: "old-call", name: "read", namespace: "mcp__local", arguments: { path: "file" } }], timestamp: 3 },
      { role: "toolResult", toolCallId: "old-call", toolName: "read", toolNamespace: "mcp__local", content: "complete result", isError: false, timestamp: 4 },
      { role: "agentMessage", author: "child", recipient: "parent", content: "readable delegation", timestamp: 5 },
      ...parsed.context.messages,
    ],
  };
  const events = await run(f.bridgeUrl, parsed);
  expect(finalText(events)).toBe("สวัสดี final answer");
  expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop", endTurn: true });
  expect(events.every(event => !("usage" in event))).toBe(true);
  const sent = f.seen.find(row => row.path === "/v1/chat/isolated");
  const prompt = promptFrom(sent?.body);
  const encoded = prompt.split("BEGIN_CODEX_CONTEXT_JSON\n")[1]?.split("\nEND_CODEX_CONTEXT_JSON")[0];
  expect(JSON.parse(encoded ?? "null")).toEqual({ ...parsed.context, tools: parsed.context.tools?.map(tool => ({ ...tool, wireName: namespacedToolName(tool.namespace, tool.name) })), options: {} });
  expect(f.seen.map(row => row.path)).toEqual(["/health", "/v1/chat/isolated"]);
  expect(f.seen.every(row => !row.headers.has("authorization") && !row.headers.has("chatgpt-account-id"))).toBe(true);
  await run(f.bridgeUrl);
  expect(f.seen.filter(row => row.path === "/v1/chat/isolated")).toHaveLength(2);
});

test("plain JSON, code blocks and quoted tool-looking text remain normal final text", async () => {
  for (const text of ['{"calls":[]}', '```json\n{"calls":[]}\n```', 'Example: <aipass-tools:fake>{}</aipass-tools:fake>']) {
    const f = fixture({ chat: () => stream(chunks(text)) });
    const events = await run(f.bridgeUrl);
    expect(finalText(events)).toBe(text);
    expect(events.some(event => event.type === "tool_call_start")).toBe(false);
  }
});

test("framed namespaced, freeform and toolSearch calls survive the existing Responses formatter", async () => {
  const f = fixture({ chat: body => stream(chunks(frame(body, [
    { name: "mcp__files__read", arguments: '{"path":"x"}' },
    { name: "apply_patch", arguments: { input: "*** Begin Patch\n*** End Patch" } },
    { name: "tool_search", arguments: { query: "files", limit: 1 } },
  ]))) });
  const parsed = request();
  parsed.context.tools = [
    { namespace: "mcp__files", name: "read", description: "read", parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } }, additionalProperties: false } },
    { name: "apply_patch", freeform: true, description: "patch", parameters: {} },
    { name: "tool_search", toolSearch: true, description: "search", parameters: { type: "object", required: ["query"], properties: { query: { type: "string" }, limit: { type: "integer" } } } },
  ];
  parsed.options.toolChoice = "required";
  const events = await run(f.bridgeUrl, parsed);
  expect(finalText(events)).toBe("");
  expect(events.at(-1)).toEqual({ type: "done", stopReason: "tool_use", endTurn: false });
  const response = buildResponseJSON(events, parsed.modelId, {
    toolNsMap: new Map([["mcp__files__read", { namespace: "mcp__files", name: "read" }]]),
    freeformToolNames: new Set(["apply_patch"]), toolSearchToolNames: new Set(["tool_search"]),
  });
  expect(response.output).toEqual([
    expect.objectContaining({ type: "function_call", namespace: "mcp__files", name: "read", arguments: '{"path":"x"}' }),
    expect.objectContaining({ type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" }),
    expect.objectContaining({ type: "tool_search_call", execution: "client", arguments: { query: "files", limit: 1 } }),
  ]);
  const ids = events.filter(event => event.type === "tool_call_start").map(event => event.id);
  expect(new Set(ids).size).toBe(3);
});

test("validates the whole tool batch before emitting any calls", async () => {
  for (const calls of [
    [{ name: "read", arguments: {} }, { name: "unknown", arguments: {} }],
    [{ name: "read", arguments: "not json" }],
    [{ name: "read", arguments: [] }],
    [{ name: "read", arguments: { path: 123 } }],
  ]) {
    const f = fixture({ chat: body => stream(chunks(frame(body, calls))) });
    const parsed = request();
    parsed.context.tools = [{ name: "read", description: "", parameters: { type: "object", properties: { path: { type: "string" } } } }];
    const events = await run(f.bridgeUrl, parsed);
    expect(events.at(-1)).toMatchObject({ type: "error", retryable: false });
    expect(events.some(event => event.type === "tool_call_start")).toBe(false);
  }
});

test("enforces none, named, allowed/required toolChoice and disabled parallel calls", async () => {
  for (const options of [
    { toolChoice: "none" },
    { toolChoice: { name: "other" } },
    { toolChoice: { allowedTools: ["other"], mode: "auto" } },
    { parallelToolCalls: false },
  ] satisfies CodexParsedRequest["options"][]) {
    const f = fixture({ chat: body => stream(chunks(frame(body, [{ name: "read", arguments: {} }, { name: "other", arguments: {} }]))) });
    const parsed = request();
    parsed.options = options;
    parsed.context.tools = ["read", "other"].map(name => ({ name, description: "", parameters: {} }));
    const events = await run(f.bridgeUrl, parsed);
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(events.some(event => event.type === "tool_call_start")).toBe(false);
  }
  for (const toolChoice of ["required", { allowedTools: ["read"], mode: "required" }] satisfies NonNullable<CodexParsedRequest["options"]["toolChoice"]>[]) {
    const f = fixture();
    const parsed = request();
    parsed.options.toolChoice = toolChoice;
    parsed.context.tools = [{ name: "read", description: "", parameters: {} }];
    const events = await run(f.bridgeUrl, parsed);
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(finalText(events)).toBe("");
  }
});

test("rejects malformed, truncated or wrong-nonce tool frames without executing partial calls", async () => {
  for (const output of [
    (body: unknown) => frame(body, [{ name: "read", arguments: {} }]).slice(0, -5),
    (body: unknown) => frame(body, [{ name: "read", arguments: {} }]).replace("\nEND_AIPASS_TOOLS_", ">\nEND_AIPASS_TOOLS_"),
    () => 'AIPASS_TOOLS_wrong\n{"calls":[]}\nEND_AIPASS_TOOLS_wrong',
    (body: unknown) => frame(body, []).replace('{"calls":[]}', "{broken}"),
  ]) {
    const f = fixture({ chat: body => stream(chunks(output(body))) });
    const events = await run(f.bridgeUrl);
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(events.some(event => event.type === "tool_call_start")).toBe(false);
  }
});

test("forwards an advertised TH AI Pass thinking level while keeping cache keys out of the prompt", async () => {
  const f = fixture();
  const parsed = parseRequest({ model: "aipass/fixture", input: "hello", stream: true, reasoning: { effort: "high" }, prompt_cache_key: "private-cache-key" });
  const events = await run(f.bridgeUrl, parsed, undefined, ["low", "medium", "high", "max"]);
  expect(events.at(-1)).toMatchObject({ type: "done" });
  const sent = f.seen.find(row => row.path === "/v1/chat/isolated");
  expect(record(sent?.body)).toHaveProperty("thinking_level", "high");
  const prompt = promptFrom(sent?.body);
  expect(prompt).not.toContain("private-cache-key");
  const encoded = prompt.split("BEGIN_CODEX_CONTEXT_JSON\n")[1]?.split("\nEND_CODEX_CONTEXT_JSON")[0];
  expect(JSON.parse(encoded ?? "null").options).toEqual({ hideThinkingSummary: true });
});

test("maps Codex Extra High to upstream max, and rejects unadvertised levels", async () => {
  const f = fixture();
  const parsed = parseRequest({ model: "aipass/fixture", input: "hello", reasoning: { effort: "xhigh" } });
  const events = await run(f.bridgeUrl, parsed, undefined, ["low", "medium", "high", "max"]);
  expect(events.at(-1)).toMatchObject({ type: "done" });
  expect(record(f.seen.find(row => row.path === "/v1/chat/isolated")?.body))
    .toHaveProperty("thinking_level", "max");
  const unsupported = await run(f.bridgeUrl, parsed, undefined, ["low", "medium", "high"]);
  expect(unsupported.at(-1)).toMatchObject({ type: "error" });
  const noMetadata = await run(f.bridgeUrl, parsed);
  expect(noMetadata.at(-1)).toMatchObject({ type: "error" });
  expect(f.seen.filter(row => row.path === "/v1/chat/isolated")).toHaveLength(1);
});

test("prefers exact thinking levels when upstream advertises both none/minimal and max/xhigh", async () => {
  const f = fixture();
  for (const effort of ["minimal", "xhigh"] as const) {
    const parsed = parseRequest({ model: "aipass/fixture", input: "hello", reasoning: { effort } });
    const events = await run(f.bridgeUrl, parsed, undefined, ["none", "minimal", "max", "xhigh"]);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  }
  const sent = f.seen.filter(row => row.path === "/v1/chat/isolated").map(row => {
    const body = record(row.body);
    return "thinking_level" in body ? body.thinking_level : undefined;
  });
  expect(sent).toEqual(["minimal", "xhigh"]);
});

test("Codex text verbosity becomes a final-answer preference without blocking chat or tool calls", async () => {
  for (const verbosity of ["low", "medium", "high"] as const) {
    for (const toolCall of [false, true]) {
      const f = fixture({ chat: body => {
        expect(promptFrom(body)).toContain(`"verbosity":"${verbosity}"`);
        expect(promptFrom(body)).toContain({ low: "concise and direct", medium: "balanced detail", high: "thorough detail" }[verbosity]);
        return stream(chunks(toolCall ? frame(body, [{ name: "read", arguments: { path: "README.md" } }]) : "TEST_OK"));
      } });
      const parsed = parseRequest({ model: "aipass/fixture", input: "hello", stream: true,
        text: { verbosity }, tools: [{ type: "function", name: "read", parameters: {
          type: "object", properties: { path: { type: "string" } }, required: ["path"],
        } }] });
      const events = await run(f.bridgeUrl, parsed);
      expect(events.at(-1)).toMatchObject({ type: "done", stopReason: toolCall ? "tool_use" : "stop" });
      if (toolCall) expect(events).toContainEqual(expect.objectContaining({ type: "tool_call_start", name: "read" }));
      else expect(finalText(events)).toBe("TEST_OK");
    }
  }
});

test("rejects unsupported capabilities before any network request", async () => {
  const f = fixture();
  const cases: CodexParsedRequest[] = [];
  for (const options of [{ temperature: 0 }, { topP: 0.5 }, { presencePenalty: 1 }, { frequencyPenalty: 1 }, { maxOutputTokens: 50 }, { serviceTier: "fast" }, { outputFormat: { type: "json_schema", name: "x", strict: true, schema: {} } }] satisfies CodexParsedRequest["options"][]) cases.push({ ...request(), options });
  cases.push(parseRequest({ model: "aipass/fixture", input: "hello", temperature: 0, reasoning: { effort: "high" }, prompt_cache_key: "key" }));
  cases.push({ ...request(), _compactionRequest: true }, { ...request(), _opaqueMultiAgentV2Payload: true }, { ...request(), previousResponseId: "missing" }, { ...request(), _rawBody: { input: [{ encrypted_content: "opaque" }] } });
  const image = request();
  image.context.messages = [{ role: "toolResult", toolCallId: "x", toolName: "view_image", isError: false, content: [{ type: "image", imageUrl: "data:image/png;base64,x" }], timestamp: 1 }];
  cases.push(image);
  for (const parsed of cases) expect((await run(f.bridgeUrl, parsed)).at(-1)).toMatchObject({ type: "error", code: "aipass_unsupported_request", retryable: false });
  expect(f.seen).toHaveLength(0);
});

test("rejects a stock bridge without isolated turn capability", async () => {
  const stock = fixture({ hardened: false });
  expect((await run(stock.bridgeUrl)).at(-1)).toMatchObject({ type: "error", code: "aipass_bridge_isolation_unproven" });
  expect(stock.seen.map(row => row.path)).toEqual(["/health"]);
  const retrying = fixture({ automaticRetries: true });
  expect((await run(retrying.bridgeUrl)).at(-1)).toMatchObject({ type: "error", code: "aipass_bridge_isolation_unproven" });
  expect(retrying.seen.map(row => row.path)).toEqual(["/health"]);
});

test("requires finish and DONE, handles errors and length without usage or automatic retries", async () => {
  for (const sse of [
    'data: {"error":{"message":"upstream failed"}}\n\ndata: [DONE]\n\n',
    'data: [DONE]\n\n',
    chunks("partial").replace("data: [DONE]\n\n", ""),
    'data: {broken}\n\n',
  ]) {
    const f = fixture({ chat: () => stream(sse) });
    const events = await run(f.bridgeUrl);
    expect(events.at(-1)).toMatchObject({ type: "error", retryable: false });
    expect(events.some(event => event.type === "done")).toBe(false);
    expect(f.seen.filter(row => row.path === "/v1/chat/isolated")).toHaveLength(1);
  }
  const f = fixture({ chat: () => stream(chunks("partial answer", "length")) });
  const events = await run(f.bridgeUrl);
  expect(finalText(events)).toBe("partial answer");
  expect(events.at(-1)).toEqual({ type: "incomplete", reason: "max_output_tokens", retryable: false, endTurn: true });
});

test("cancels an active streaming HTTP request and allows a subsequent turn without retry", async () => {
  let started = () => {};
  const ready = new Promise<void>(resolve => { started = resolve; });
  const f = fixture({ chat: () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(": ready\n\n")); started();
  } }), { headers: { "content-type": "text/event-stream" } }) });
  const controller = new AbortController();
  const active = run(f.bridgeUrl, request(), controller.signal);
  await ready;
  controller.abort();
  expect((await active).at(-1)).toMatchObject({ type: "error", code: "aipass_cancelled", retryable: false });
  expect(f.seen.filter(row => row.path === "/v1/chat/isolated")).toHaveLength(1);
  const next = fixture();
  expect((await run(next.bridgeUrl)).at(-1)).toMatchObject({ type: "done" });
});

test("validates HTTP loopback origins and refuses redirects", async () => {
  for (const bridgeUrl of ["https://127.0.0.1:1234", "http://localhost:1234", "http://example.com", "http://127.0.0.1:1234/path", "http://user:pass@127.0.0.1", "http://127.0.0.1?x=1", "http://127.0.0.1#x"]) {
    expect(() => createAiPassAdapter({ bridgeUrl, model: "fixture" })).toThrow();
  }
  const destination = fixture();
  const f = fixture({ chat: () => Response.redirect(`${destination.bridgeUrl}/v1/chat/isolated`, 307) });
  expect((await run(f.bridgeUrl)).at(-1)).toMatchObject({ type: "error", retryable: false });
  expect(destination.seen).toHaveLength(0);
});

test("accepts exact named/allowed choices, preserves freeform input and expanded readable history", async () => {
  for (const toolChoice of [{ name: "mcp__local__exec" }, { allowedTools: ["mcp__local__exec"], mode: "required" }] satisfies NonNullable<CodexParsedRequest["options"]["toolChoice"]>[]) {
    const input = "line 1\n`literal` $() ไทย";
    const f = fixture({ chat: body => stream(chunks(frame(body, [{ name: "mcp__local__exec", arguments: { input } }]))) });
    const parsed = request();
    parsed.previousResponseId = "expanded";
    parsed._replayPrefixLen = 2;
    parsed.options = { toolChoice, parallelToolCalls: false };
    parsed.context.tools = [{ name: "exec", namespace: "mcp__local", freeform: true, description: "request only", parameters: {} }];
    const events = await run(f.bridgeUrl, parsed);
    expect(events).toContainEqual({ type: "tool_call_delta", arguments: JSON.stringify({ input }) });
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: false });
  }
});

test("rejects malformed freeform input and incomplete tool frames at output limit", async () => {
  for (const [args, finish] of [[{ input: 123 }, "stop"], [{ input: "valid" }, "length"]] satisfies [unknown, string][]) {
    const f = fixture({ chat: body => stream(chunks(frame(body, [{ name: "exec", arguments: args }]), finish)) });
    const parsed = request();
    parsed.context.tools = [{ name: "exec", freeform: true, description: "", parameters: {} }];
    const events = await run(f.bridgeUrl, parsed);
    expect(events.at(-1)).toMatchObject({ type: "error", retryable: false });
    expect(events.some(event => event.type === "tool_call_start")).toBe(false);
  }
});

test("pre-aborted requests never contact the bridge; schema fields are not mistaken for opaque history", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  expect((await run(f.bridgeUrl, request(), controller.signal)).at(-1)).toMatchObject({ type: "error", code: "aipass_cancelled" });
  expect(f.seen).toHaveLength(0);
  const parsed = request();
  parsed._rawBody = { tools: [{ name: "inspect", parameters: { properties: { signature: { type: "string" } } } }] };
  expect((await run(f.bridgeUrl, parsed)).at(-1)).toMatchObject({ type: "done" });
});

test("forwards real streamed reasoning only when visible summaries are requested", async () => {
  const reasoning = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: "real thought" }, finish_reason: null }] })}\n\n`;
  for (const hideThinkingSummary of [true, false]) {
    const f = fixture({ chat: () => stream(reasoning + chunks("answer")) });
    const parsed = request();
    parsed.options.hideThinkingSummary = hideThinkingSummary;
    const events = await run(f.bridgeUrl, parsed);
    expect(events.filter(event => event.type === "thinking_delta")).toEqual(hideThinkingSummary ? [] : [{ type: "thinking_delta", thinking: "real thought" }]);
    expect(finalText(events)).toBe("answer");
  }
});
