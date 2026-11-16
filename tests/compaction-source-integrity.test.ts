import { expect, test } from "bun:test";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import type { CodexParsedRequest } from "../src/types";
import { CompactionSourceOverflowError, partitionCompactionSource, summarizeCompleteCompaction } from "../src/adapters/chatgpt-web/compaction-source";

test("oversized compaction refuses to silently discard the original task", () => {
  const input: CodexParsedRequest = {
    modelId: "gpt-5.6-sol", stream: true, options: { reasoning: "high" },
    _compactionRequest: true,
    context: {
      systemPrompt: [],
      messages: [
        { role: "user", content: "MISSION-7391 must survive compaction", timestamp: 1 },
        { role: "user", content: "archive ".repeat(24_000), timestamp: 2 },
        { role: "user", content: "Produce a checkpoint", timestamp: 3 },
      ],
    },
  };
  expect(() => compileChatGptWebPrompt(input, {
    localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true,
  })).toThrow("complete history");
});

const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };
function fits(input: CodexParsedRequest): boolean {
  try { compileChatGptWebPrompt(input, capabilities); return true; }
  catch (error) { if (error instanceof CompactionSourceOverflowError) return false; throw error; }
}
function source(content: string): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol", stream: true, options: { reasoning: "high" }, _compactionRequest: true,
    context: { systemPrompt: [], messages: [
      { role: "user", content, timestamp: 1 },
      { role: "user", content: "Create a concise checkpoint preserving all task facts.", timestamp: 2 },
    ] },
  };
}

test("compaction parts cover the entire original text without changing the source", () => {
  const text = "MISSION-7391 " + "archive 👩‍💻 retained receipt\n".repeat(8_000) + " FINAL-FACT-42";
  const input = source(text);
  const before = structuredClone(input);
  const parts = partitionCompactionSource(input, fits);
  expect(parts.length).toBeGreaterThan(1);
  expect(parts.every(fits)).toBeTrue();
  const fragments = parts.flatMap(part => part.context.messages.slice(0, -1));
  expect(fragments.map(message => message.content).join("")).toBe(text);
  expect(input).toEqual(before);
});

test("splitting an oversized mixed record retains its actual image attachment", () => {
  const input = source("");
  input.context.messages[0] = { role: "user", timestamp: 1, content: [
    { type: "text", text: "archival-text ".repeat(14_000) },
    { type: "image", imageUrl: "data:image/png;base64,unchanged-image" },
  ] };
  const parts = partitionCompactionSource(input, fits);
  const compiled = parts.map(part => compileChatGptWebPrompt(part, capabilities));
  expect(compiled.flatMap(part => part.images).map(image => image.imageUrl)).toEqual(["data:image/png;base64,unchanged-image"]);
  const text = parts.flatMap(part => part.context.messages.slice(0, -1)).flatMap(message =>
    typeof message.content === "string" ? [message.content] : message.content.flatMap(part => part.type === "text" ? [part.text] : []));
  expect(text.join("")).toBe("archival-text ".repeat(14_000));
});

test("complete reduction submits every task fact before returning its final checkpoint", async () => {
  const input = source("");
  input.context.messages = Array.from({ length: 6 }, (_, index) => ({
    role: "user", timestamp: index, content: `TASKFACT:${index} ${"archive ".repeat(150)}`,
  }));
  input.context.messages.push({ role: "user", timestamp: 9, content: "Summarize every task fact" });
  const observed = new Set<string>();
  let calls = 0;
  const summary = await summarizeCompleteCompaction(input, {
    fits: part => JSON.stringify(part.context.messages).length < 2000,
    summarize: async part => {
      calls += 1;
      const facts = JSON.stringify(part.context.messages).match(/TASKFACT:\d/g) ?? [];
      for (const fact of facts) observed.add(fact);
      return [...new Set(facts)].join(" ");
    },
  });
  expect([...observed].sort()).toEqual(Array.from({ length: 6 }, (_, index) => `TASKFACT:${index}`));
  for (let index = 0; index < 6; index += 1) expect(summary).toContain(`TASKFACT:${index}`);
  expect(calls).toBeGreaterThan(1);
});

test("failed or cancelled source summaries publish no partial checkpoint", async () => {
  const input = source("archive ".repeat(1000));
  const abort = new AbortController();
  let calls = 0;
  await expect(summarizeCompleteCompaction(input, {
    fits: part => JSON.stringify(part.context.messages).length < 2000,
    signal: abort.signal,
    summarize: async () => { calls += 1; abort.abort(); return "partial result"; },
  })).rejects.toThrow();
  expect(calls).toBe(1);
});

test("a summary that grows the source fails instead of looping", async () => {
  await expect(summarizeCompleteCompaction(source("archive ".repeat(1000)), {
    fits: part => JSON.stringify(part.context.messages).length < 2000,
    summarize: async () => "unbounded summary ".repeat(1000),
  })).rejects.toThrow("did not reduce");
});
