import { expect, test } from "bun:test";
import { CompactionSourceOverflowError, partitionCompactionSource, summarizeCompleteCompaction } from "../src/adapters/chatgpt-web/compaction-source";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import {
  compileChatGptWebPrompt,
  type CompiledChatGptWebPrompt,
} from "../src/adapters/chatgpt-web/prompt";
import {
  compiledChatGptWebMessages,
  estimateChatGptWebImageTokens,
  estimateCompiledChatGptWebInputTokens,
} from "../src/adapters/chatgpt-web/input-tokens";
import {
  assertChatGptWebMultipartInputWithinLimits,
  resolveChatGptWebMultipartStagingMode,
} from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_LUNA_MODEL_ID, CHATGPT_WEB_MODEL_ID, resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "../src/adapters/chatgpt-web/model";
import { skillFileTokens } from "../src/adapters/chatgpt-web/skill-attachments";
import { estimateTokens } from "../src/lib/token-estimate";
import { SUMMARY_PREFIX } from "../src/responses/compaction";
import type { CodexParsedRequest } from "../src/types";

const capabilities: ChatGptWebCapabilities = {
  localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true,
};
const turnToken = `turn_${"0".repeat(32)}`;

function request(): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    _chatgptModelFamily: "6",
    _compactionRequest: true,
    context: { systemPrompt: ["preserve system instructions"], messages: [] },
    stream: false,
    options: { reasoning: "xhigh" },
  };
}

function assertMultipartFits(
  compiled: CompiledChatGptWebPrompt,
  parsed: CodexParsedRequest,
  caps = capabilities,
): void {
  const messages = compiledChatGptWebMessages(compiled);
  const tokens = messages.map(message => estimateTokens(message, parsed.modelId));
  const chars = messages.map(message => message.length);
  const maxStageMessageTokens = Math.max(...tokens.slice(0, -1));
  const maxStageChars = Math.max(...chars.slice(0, -1));
  const staging = resolveChatGptWebMultipartStagingMode(parsed.modelId, caps, maxStageMessageTokens, maxStageChars);
  const finalMessageTokens = tokens.at(-1)! + skillFileTokens(compiled.skillFiles, parsed.modelId);
  assertChatGptWebMultipartInputWithinLimits(
    estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId),
    Math.max(...tokens.slice(0, -1), finalMessageTokens),
    parsed.modelId, resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, caps).effort,
    caps, Math.max(...chars), compiled.multipart!.parts.length,
    { stagingEffort: staging.effort, maxStageMessageTokens, maxStageChars,
      finalMessageTokens, finalMessageChars: chars.at(-1)!, finalImageTokens: estimateChatGptWebImageTokens(compiled) },
    parsed._chatgptModelFamily,
  );
}

type CompiledMessage = { role: string; content: unknown; tool_call_id?: string };

function multipartRecords(compiled: CompiledChatGptWebPrompt) {
  return compiled.multipart!.parts.flatMap(part => {
    const payload: { records: Array<
      { kind: "system"; content: unknown } | { kind: "message"; message: CompiledMessage }
    > } = JSON.parse(part);
    return payload.records;
  });
}

function multipartMessages(compiled: CompiledChatGptWebPrompt): CompiledMessage[] {
  return multipartRecords(compiled).flatMap(record => record.kind === "message" ? [record.message] : []);
}

function sourceCompiler(
  caps = capabilities,
  options: NonNullable<Parameters<typeof compileChatGptWebPrompt>[3]> = { experimentalMultipartParts: 6 },
) {
  const compile = (source: CodexParsedRequest) => compileChatGptWebPrompt(source, caps, turnToken, options);
  const fits = (source: CodexParsedRequest): boolean => {
    try {
      assertMultipartFits(compile(source), source, caps);
      return true;
    } catch (error) {
      if (error instanceof CompactionSourceOverflowError) return false;
      if (error instanceof ChatGptWebAdapterError && error.code === "context_length_exceeded") return false;
      throw error;
    }
  };
  return { compile, fits };
}

function compileSourceParts(
  input: CodexParsedRequest,
  caps = capabilities,
  options: NonNullable<Parameters<typeof compileChatGptWebPrompt>[3]> = { experimentalMultipartParts: 6 },
) {
  const before = structuredClone(input);
  const { compile, fits } = sourceCompiler(caps, options);
  const parts = partitionCompactionSource(input, fits);
  expect(parts.length).toBeGreaterThan(0);
  const results = parts.map(source => {
    const compiled = compile(source);
    expect(() => assertMultipartFits(compiled, source, caps)).not.toThrow();
    expect(compiled.multipart!.parts).toHaveLength(options.experimentalMultipartParts!);
    expect(compiled.trimmedCompactionMessages).toBeUndefined();
    expect(compiled.multipart!.commit).not.toContain("history is incomplete");
    expect(compiled.multipart!.commit).not.toContain("earlier history items were omitted");
    expect(source.context.systemPrompt).toEqual(input.context.systemPrompt);
    expect(multipartRecords(compiled).filter(record => record.kind === "system").map(record => record.content))
      .toEqual(input.context.systemPrompt ?? []);
    expect(source.context.messages.at(-1)).toEqual(input.context.messages.at(-1));
    const messages = multipartMessages(compiled);
    expect(messages.at(-1)).toEqual({ role: "user", content: input.context.messages.at(-1)!.content });
    return { source, compiled, messages: messages.slice(0, -1) };
  });
  expect(input).toEqual(before);
  return results;
}

test.each(["string", "text parts"] as const)("#930: GPT-6 Pro compaction preserves every source record above the six-part ceiling (%s checkpoint)", checkpointFormat => {
  const parsed = request();
  const checkpoint = `${SUMMARY_PREFIX}\nVerified cumulative progress and pending work`;
  parsed.context.messages = [
    { role: "user", content: `${SUMMARY_PREFIX}\nObsolete checkpoint`, timestamp: 1 },
    { role: "user", content: checkpointFormat === "text parts" ? [{ type: "text", text: checkpoint }] : checkpoint, timestamp: 2 },
    ...Array.from({ length: 12 }, (_, index): CodexParsedRequest["context"]["messages"] => [
      { role: "assistant", content: [{ type: "toolCall", id: `read-${index}`, name: "read", arguments: { path: `file-${index}` } }], timestamp: index * 2 + 3 },
      { role: "toolResult", toolCallId: `read-${index}`, toolName: "read", isError: false,
        content: `history-${index} ${"word ".repeat(22_000)}`, timestamp: index * 2 + 4 },
    ]).flat(),
    { role: "assistant", content: [{ type: "text", text: "recent verified progress" }], timestamp: 27 },
    { role: "user", content: "Produce the cumulative checkpoint now.", timestamp: 28 },
  ];
  const before = structuredClone(parsed);
  expect(() => compileChatGptWebPrompt(parsed, capabilities, turnToken, { experimentalMultipartParts: 6 }))
    .toThrow("complete history");
  const parts = compileSourceParts(parsed);
  expect(parts.length).toBeGreaterThan(1);
  expect(parts.flatMap(part => part.source.context.messages.slice(0, -1)))
    .toEqual(parsed.context.messages.slice(0, -1));
  const messages = parts.flatMap(part => part.messages);
  expect(messages.map(message => message.role)).toEqual(parsed.context.messages.slice(0, -1).map(message =>
    message.role === "toolResult" ? "tool_result" : message.role));
  expect(messages[0]!.content).toBe(`${SUMMARY_PREFIX}\nObsolete checkpoint`);
  expect(messages[1]!.content).toBe(checkpoint);
  expect(messages.filter(message => message.role === "tool_result").map(message => message.tool_call_id))
    .toEqual(Array.from({ length: 12 }, (_, index) => `read-${index}`));
  expect(messages.filter(message => message.role === "tool_result").map(message => message.content))
    .toEqual(parsed.context.messages.filter(message => message.role === "toolResult").map(message => message.content));
  expect(messages.filter(message => message.role === "assistant").slice(0, -1).map(message => message.content))
    .toEqual(Array.from({ length: 12 }, (_, index) => [{
      type: "tool_call", id: `read-${index}`, name: "read", arguments: { path: `file-${index}` },
    }]));
  expect(messages.at(-1)!.content).toEqual([{ type: "text", text: "recent verified progress" }]);
  expect(parsed).toEqual(before);
}, 30_000);

test.each([
  { family: "6", pro: true, effort: "xhigh", parts: 2, count: 12, words: 20_000, ceiling: 222_386 },
  { family: "6", pro: false, effort: "high", parts: 2, count: 7, words: 20_000, ceiling: 120_000 },
  { family: "6", pro: false, effort: "high", parts: 6, count: 7, words: 20_000, ceiling: 120_000 },
  { family: "5.6", pro: false, effort: "high", parts: 6, count: 14, words: 20_000, ceiling: 270_000 },
  { family: "5.6", pro: true, effort: "high", parts: 6, count: 17, words: 20_000, ceiling: 333_579 },
  { family: "6", pro: true, effort: "max", parts: 6, count: 17, words: 20_000, ceiling: 336_579 },
] as const)("compaction uses the browser's account, family, effort and part-count ceiling: %j", scenario => {
  const parsed = request();
  parsed._chatgptModelFamily = scenario.family;
  parsed.options.reasoning = scenario.effort;
  parsed.context.messages = [
    ...Array.from({ length: scenario.count }, (_, index) => ({
      // Keep character pressure independent of the total-token boundary under test.
      role: "user" as const, content: `history-${index} ${"x ".repeat(scenario.words)}`, timestamp: index + 1,
    })),
    { role: "user", content: "checkpoint now", timestamp: scenario.count + 1 },
  ];
  const caps = { ...capabilities, proAvailable: scenario.pro };
  const before = structuredClone(parsed);
  expect(() => compileChatGptWebPrompt(parsed, caps, turnToken, { experimentalMultipartParts: scenario.parts }))
    .toThrow("complete history");
  const parts = compileSourceParts(parsed, caps, { experimentalMultipartParts: scenario.parts });
  expect(parts.length).toBeGreaterThan(1);
  for (const part of parts) {
    expect(estimateCompiledChatGptWebInputTokens(part.compiled, parsed.modelId)).toBeLessThan(scenario.ceiling);
  }
  expect(parts.flatMap(part => part.source.context.messages.slice(0, -1)))
    .toEqual(parsed.context.messages.slice(0, -1));
  expect(parts.flatMap(part => part.messages).map(message => message.content))
    .toEqual(parsed.context.messages.slice(0, -1).map(message => message.content));
  expect(parsed).toEqual(before);
}, 30_000);

test("Luna multipart compaction uses its experimental ceiling instead of its rolling context window", () => {
  const parsed = request();
  parsed.modelId = CHATGPT_WEB_LUNA_MODEL_ID;
  delete parsed._chatgptModelFamily;
  parsed.options.reasoning = "low";
  parsed.context.messages = [
    ...Array.from({ length: 11 }, (_, index) => ({
      role: "user" as const, content: `history-${index} ${"word ".repeat(8_000)}`, timestamp: index + 1,
    })),
    { role: "user", content: "checkpoint now", timestamp: 12 },
  ];
  const caps = { ...capabilities, solAvailable: false, extraHighAvailable: false, proAvailable: false };
  const before = structuredClone(parsed);
  expect(() => compileChatGptWebPrompt(parsed, caps, turnToken, { experimentalMultipartParts: 6 }))
    .toThrow("complete history");
  const parts = compileSourceParts(parsed, caps);
  expect(parts.length).toBeGreaterThan(1);
  for (const part of parts) {
    expect(estimateCompiledChatGptWebInputTokens(part.compiled, parsed.modelId)).toBeLessThan(84_000);
  }
  expect(parts.flatMap(part => part.source.context.messages.slice(0, -1)))
    .toEqual(parsed.context.messages.slice(0, -1));
  expect(parts.flatMap(part => part.messages).map(message => message.content))
    .toEqual(parsed.context.messages.slice(0, -1).map(message => message.content));
  expect(parsed).toEqual(before);
});

test("multipart compaction keeps history just below the ceiling without an extra percentage margin", () => {
  const parsed = request();
  parsed.context.messages = [
    ...Array.from({ length: 10 }, (_, index) => ({
      role: "user" as const, content: `history-${index} ${"word ".repeat(22_400)}`, timestamp: index + 1,
    })),
    { role: "user", content: "checkpoint now", timestamp: 11 },
  ];
  const compiled = compileChatGptWebPrompt(parsed, capabilities, turnToken, { experimentalMultipartParts: 6 });
  const tokens = estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId);
  expect(tokens).toBeGreaterThan(235_000);
  expect(tokens).toBeLessThan(240_000);
  expect(compiled.trimmedCompactionMessages).toBeUndefined();
  expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records)
    .filter(record => record.kind === "message").map(record => record.message.content))
    .toEqual(parsed.context.messages.map(message => message.content));
  expect(compiled.multipart!.commit).not.toContain("history is incomplete");
  expect(() => assertMultipartFits(compiled, parsed)).not.toThrow();
});

test("ordinary multipart turns retain all history and fail preflight above the ceiling", () => {
  const parsed = request();
  delete parsed._compactionRequest;
  parsed.context.messages = Array.from({ length: 12 }, (_, index) => ({
    role: "user", content: `history-${index} ${"word ".repeat(22_000)}`, timestamp: index + 1,
  }));
  const before = structuredClone(parsed);
  const compiled = compileChatGptWebPrompt(parsed, capabilities, turnToken, { experimentalMultipartParts: 6 });
  expect(compiled.trimmedCompactionMessages).toBeUndefined();
  expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records)
    .filter(record => record.kind === "message").map(record => record.message.content))
    .toEqual(parsed.context.messages.map(message => message.content));
  expect(() => assertMultipartFits(compiled, parsed)).toThrow("240,000-token six-part ceiling");
  expect(parsed).toEqual(before);
});

test.each(["checkpoint", "final instruction", "system"] as const)(
  "multipart compaction fails closed when required %s exceeds the total ceiling", required => {
    const parsed = request();
    parsed.context.messages = [
      { role: "user", content: "discardable history", timestamp: 1 },
      { role: "user", content: "checkpoint now", timestamp: 3 },
    ];
    const oversized = "word ".repeat(240_000);
    if (required === "checkpoint") {
      parsed.context.messages.splice(1, 0, {
        role: "user", content: `${SUMMARY_PREFIX}\n${oversized}`, timestamp: 2,
      });
    } else if (required === "final instruction") {
      parsed.context.messages.at(-1)!.content = oversized;
    } else {
      parsed.context.systemPrompt = Array.from({ length: 4 }, () => "word ".repeat(60_000));
    }
    const before = structuredClone(parsed);
    let error: unknown;
    try {
      compileChatGptWebPrompt(parsed, capabilities, turnToken, { experimentalMultipartParts: 6 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CompactionSourceOverflowError);
    expect(error).toMatchObject({ code: "compaction_source_overflow", retryable: false, status: 400 });
    if (!(error instanceof CompactionSourceOverflowError)) throw error;
    expect(error.message).toContain("complete history");
    expect(error.message).not.toContain("Run /compact");
    if (required !== "checkpoint") {
      expect(() => partitionCompactionSource(parsed, sourceCompiler().fits)).toThrow("complete history");
    } else {
      const parts = compileSourceParts(parsed);
      expect(parts.length).toBeGreaterThan(1);
      expect(parts.flatMap(part => part.messages).map(message => message.content).join(""))
        .toBe(parsed.context.messages.slice(0, -1).map(message => message.content).join(""));
    }
    expect(parsed).toEqual(before);
  }, 30_000,
);

test("multipart compaction rejects an oversized atomic stage then partitions its complete text", () => {
  const parsed = request();
  parsed.context.messages = [
    { role: "user", content: "word ".repeat(110_000), timestamp: 1 },
    { role: "user", content: "checkpoint now", timestamp: 2 },
  ];
  const before = structuredClone(parsed);
  expect(() => compileChatGptWebPrompt(parsed, capabilities, turnToken, { experimentalMultipartParts: 6 }))
    .toThrow("complete history");
  const ordinary = { ...parsed, _compactionRequest: false };
  const compiled = compileChatGptWebPrompt(ordinary, capabilities, turnToken, { experimentalMultipartParts: 6 });
  expect(estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId)).toBeLessThan(240_000);
  expect(compiled.trimmedCompactionMessages).toBeUndefined();
  expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records)
    .filter(record => record.kind === "message").map(record => record.message.content))
    .toEqual(parsed.context.messages.map(message => message.content));
  expect(() => assertMultipartFits(compiled, parsed)).toThrow("No ChatGPT effort available");
  const parts = compileSourceParts(parsed);
  expect(parts.flatMap(part => part.source.context.messages.slice(0, -1)).length).toBeGreaterThan(1);
  const originalText = parsed.context.messages[0]?.content;
  if (typeof originalText !== "string") throw new Error("Expected an oversized text source");
  expect(parts.flatMap(part => part.messages).map(message => message.content).join(""))
    .toBe(originalText);
  expect(parsed).toEqual(before);
});

test("multipart compaction retains all image and skill attachments across source parts", () => {
  const parsed = request();
  parsed.context.messages = [
    { role: "user", content: [{ type: "image", imageUrl: "data:image/png;base64,old-image", detail: "original" }], timestamp: 1 },
    { role: "user", origin: "codex_skill", content: `<skill><name>old-skill</name>${"word ".repeat(8_000)}</skill>`, timestamp: 2 },
    ...Array.from({ length: 10 }, (_, index) => ({
      role: "user" as const, content: `history-${index} ${"word ".repeat(22_000)}`, timestamp: index + 3,
    })),
    { role: "user", content: [{ type: "image", imageUrl: "data:image/png;base64,new-image", detail: "original" }], timestamp: 13 },
    { role: "user", origin: "codex_skill", content: `<skill><name>new-skill</name>${"word ".repeat(3_000)}</skill>`, timestamp: 14 },
    { role: "user", content: "checkpoint now", timestamp: 15 },
  ];
  const before = structuredClone(parsed);
  const parts = compileSourceParts(parsed, capabilities, {
    experimentalMultipartParts: 6, experimentalSkillAttachments: true, includeContextTokenBreakdown: true,
  });
  expect(parts.length).toBeGreaterThan(1);
  expect(parts.flatMap(part => part.source.context.messages.slice(0, -1)))
    .toEqual(parsed.context.messages.slice(0, -1));
  expect(parts.flatMap(part => part.compiled.images).map(({ imageUrl, detail }) => ({ imageUrl, detail })))
    .toEqual([
      { imageUrl: "data:image/png;base64,old-image", detail: "original" },
      { imageUrl: "data:image/png;base64,new-image", detail: "original" },
    ]);
  expect(parts.flatMap(part => part.compiled.skillFiles ?? []).map(file => file.text))
    .toEqual([parsed.context.messages[1]!.content, parsed.context.messages.at(-2)!.content]
      .filter((content): content is string => typeof content === "string"));
  for (const part of parts) {
    const messages = multipartMessages(part.compiled);
    expect(part.compiled.contextTokenBreakdown!.user!.records).toBe(messages.length);
    for (const image of part.compiled.images) {
      expect(messages.some(message => JSON.stringify(message.content).includes(JSON.stringify({
        type: "image_attachment", attachment_ref: image.ref, detail: image.detail,
      })))).toBeTrue();
    }
    for (const file of part.compiled.skillFiles ?? []) {
      expect(messages.some(message => JSON.stringify(message.content) === JSON.stringify([
        { type: "skill_attachment", filename: file.name },
      ]))).toBeTrue();
    }
  }
  expect(parts.flatMap(part => part.messages).map(message => message.content).slice(2, -2))
    .toEqual(parsed.context.messages.slice(2, -3).map(message => message.content));
  expect(parsed).toEqual(before);
}, 30_000);

test("complete compaction reduces every compiled source part before publishing the combined checkpoint", async () => {
  const parsed = request();
  parsed.options.reasoning = "high";
  parsed.context.messages = [
    ...Array.from({ length: 7 }, (_, index): CodexParsedRequest["context"]["messages"][number] => ({
      role: "toolResult", toolCallId: `read-${index}`, toolName: "read", isError: false,
      content: `FACT-${index} ${"x ".repeat(20_000)}`, timestamp: index,
    })),
    { role: "user", content: "Preserve every FACT and tool ID in the final checkpoint.", timestamp: 8 },
  ];
  const before = structuredClone(parsed);
  const caps = { ...capabilities, proAvailable: false };
  const { compile, fits } = sourceCompiler(caps, { experimentalMultipartParts: 2 });
  expect(fits(parsed)).toBeFalse();
  const submitted: CodexParsedRequest[] = [];
  const observed: CompiledMessage[] = [];
  const summary = await summarizeCompleteCompaction(parsed, {
    fits,
    summarize: async (source, part) => {
      expect(part).toBe(submitted.length);
      submitted.push(structuredClone(source));
      const compiled = compile(source);
      expect(() => assertMultipartFits(compiled, source, caps)).not.toThrow();
      expect(compiled.trimmedCompactionMessages).toBeUndefined();
      const messages = multipartMessages(compiled);
      expect(messages.at(-1)).toEqual({ role: "user", content: parsed.context.messages.at(-1)!.content });
      observed.push(...messages.filter(message => message.role === "tool_result"));
      return messages.slice(0, -1).flatMap(message => [
        ...(JSON.stringify(message.content).match(/FACT-\d+/g) ?? []),
        ...(message.tool_call_id ? [message.tool_call_id] : []),
        ...(JSON.stringify(message.content).match(/read-\d+/g) ?? []),
      ]).join(" ");
    },
  });
  expect(submitted.length).toBeGreaterThan(2);
  expect(observed.map(message => message.tool_call_id)).toEqual(Array.from({ length: 7 }, (_, index) => `read-${index}`));
  expect(observed.map(message => message.content)).toEqual(parsed.context.messages.slice(0, -1).map(message => message.content));
  for (let index = 0; index < 7; index += 1) {
    expect(summary).toContain(`FACT-${index}`);
    expect(summary).toContain(`read-${index}`);
  }
  expect(submitted.at(-1)!.context.messages.slice(0, -1).every(message =>
    typeof message.content === "string" && message.content.startsWith(SUMMARY_PREFIX))).toBeTrue();
  expect(parsed).toEqual(before);
}, 30_000);
