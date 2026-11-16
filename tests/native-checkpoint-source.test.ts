import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveCurrentCodexRolloutEnvironment } from "../src/adapters/chatgpt-web/codex-rollout-environment";

const threadId = "01a1ddf9-946b-7df3-a76c-a8f2b00cdcb8";
const turnId = "01a1ddf9-ef97-72a1-aafc-9ac83c44d16a";
const oldTurnId = "01a1ddf9-9540-7f03-8def-198bdded7418";
const temporaryHomes: string[] = [];
afterEach(() => { for (const home of temporaryHomes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function fixture() {
  const codexHome = mkdtempSync(join(tmpdir(), "native-source-"));
  temporaryHomes.push(codexHome);
  const path = join(codexHome, "sessions", "2026", "11", "15", `rollout-2026-11-15T13-51-23-${threadId}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  const original = {
    type: "message", id: "msg_mission", role: "user",
    content: [{ type: "input_text", text: "mission_code=NORTHSTAR; target_file=proof.txt; required_content=continuity-ok. Original full evidence." }],
    internal_chat_message_metadata_passthrough: { turn_id: oldTurnId },
  };
  const retainedSource = { id: { message_id: original.id, turn_id: oldTurnId, role: "user" }, revision: "rev_original", complete: false };
  const checkpoint = { type: "compaction", id: "cmp_native", encrypted_content: "native-ciphertext", internal_chat_message_metadata_passthrough: { turn_id: turnId } };
  const context = { type: "turn_context", payload: { turn_id: turnId, cwd: codexHome, permission_profile: { type: "disabled" }, sandbox_policy: { type: "danger-full-access" } } };
  const metadata = { history_sequence: 1, sampled_through_sequence: 0, retained_source: retainedSource, user_input_order: 0 };
  const compacted = { type: "compacted", payload: {
    replacement_history: [{ ...original, content: [{ type: "input_text", text: "mission_code=NORTHSTAR<truncated omitted_approx_tokens=\"8\" /> evidence." }] }, checkpoint],
    replacement_history_metadata: [metadata, { history_sequence: 2, sampled_through_sequence: 1 }],
  } };
  let rows: Record<string, unknown>[] = [
    { type: "session_meta", payload: { id: threadId, source: "vscode" } },
    { type: "response_item", payload: original, metadata }, compacted, context,
  ];
  const save = () => writeFileSync(path, rows.map((row, ordinal) => JSON.stringify({ ordinal, ...row })).join("\n") + "\n");
  save();
  const options = {
    codexHome, sqliteHome: codexHome, lineage: { threadId, sandboxType: "dangerFullAccess" as const, workspaceRoots: [codexHome] }, turnId,
    checkpointSources: [{ encryptedContent: checkpoint.encrypted_content, itemId: checkpoint.id }],
  };
  return { options, path, rows, original, metadata, compacted, checkpoint, context, save };
}

test("recovers the original mission without a native recall and without duplicating retained partial copies", () => {
  const f = fixture();
  const result = resolveCurrentCodexRolloutEnvironment(f.options);
  expect(result?.checkpointSources).toHaveLength(1);
  expect(result?.checkpointSources?.[0]?.encryptedContent).toBe("native-ciphertext");
  expect(result?.checkpointSources?.[0]?.messages.map(m => m.content)).toEqual([f.original.content.map(p => p.text).join("")]);
  expect(result?.checkpointSources?.[0]?.sourceHash).toMatch(/^[a-f0-9]{64}$/);
  expect(resolveCurrentCodexRolloutEnvironment(f.options)?.checkpointSources?.[0]?.sourceHash).toBe(result?.checkpointSources?.[0]?.sourceHash);
});

test("paginated forks recover only their native-authenticated parent prefix", () => {
  const f = fixture();
  const childId = "01a1e074-fcd1-71f1-8b32-55af68c2b2ee";
  const childTurn = "01a1e075-0003-7453-9282-846e41401864";
  const prefixBytes = readFileSync(f.path).length;
  const childPath = join(dirname(f.path), `rollout-2026-11-15T18-25-24-${childId}.jsonl`);
  const childMeta = {
    ordinal: f.rows.length, type: "session_meta", payload: {
      id: childId, source: "vscode", forked_from_id: threadId,
      forked_from_ordinal_exclusive: f.rows.length,
      history_base: { thread_id: threadId, end_ordinal_exclusive: f.rows.length, end_byte_offset: prefixBytes },
    },
  };
  const save = () => writeFileSync(childPath, [childMeta, {
    ordinal: f.rows.length + 1, ...f.context, payload: { ...f.context.payload, turn_id: childTurn },
  }].map(row => JSON.stringify(row)).join("\n") + "\n");
  save();
  const options = { ...f.options, lineage: { ...f.options.lineage, threadId: childId }, turnId: childTurn };
  const recovered = resolveCurrentCodexRolloutEnvironment(options);
  expect(JSON.stringify(recovered?.checkpointSources?.[0]?.messages)).toContain("target_file=proof.txt");
  const hash = recovered?.checkpointSources?.[0]?.sourceHash;
  f.rows.push({ type: "event_msg", payload: { type: "token_count", tokens: 900 } });
  f.save();
  expect(resolveCurrentCodexRolloutEnvironment(options)?.checkpointSources?.[0]?.sourceHash).toBe(hash);
  childMeta.payload.history_base.end_byte_offset -= 1;
  save();
  expect(() => resolveCurrentCodexRolloutEnvironment(options)).toThrow();
});

test("native Unicode truncation markers still bind to the complete original revision", () => {
  const f = fixture();
  const retained = f.compacted.payload.replacement_history[0];
  if (!retained || !("content" in retained)) throw new Error("Fixture must start with a retained message");
  retained.content = [{ type: "input_text", text: "mission_code=NORTHSTAR…8 tokens truncated… evidence." }];
  f.save();
  const source = resolveCurrentCodexRolloutEnvironment(f.options)?.checkpointSources?.[0];
  expect(JSON.stringify(source?.messages)).toContain("required_content=continuity-ok");
});

test("pre-turn compaction recovers its checkpoint only from the exact latest source turn", () => {
  const f = fixture();
  const request = { ...f.options, turnId: oldTurnId };
  expect(() => resolveCurrentCodexRolloutEnvironment(request)).toThrow();
  const recovered = resolveCurrentCodexRolloutEnvironment({ ...request, compactionSourceTurnId: turnId });
  expect(JSON.stringify(recovered?.checkpointSources?.[0]?.messages)).toContain("required_content=continuity-ok");
  expect(() => resolveCurrentCodexRolloutEnvironment({ ...request, compactionSourceTurnId: oldTurnId })).toThrow();
});

test("failed pre-turn compaction retries require a live native task and the latest persisted instruction", () => {
  const f = fixture();
  const nextTurn = "01a1e08f-d912-7fd0-bed1-860c72c0158c";
  f.rows.push({ type: "response_item", payload: {
    ...f.original, id: "msg_failed", internal_chat_message_metadata_passthrough: { turn_id: oldTurnId },
  }, metadata: { ...f.metadata, history_sequence: 3, sampled_through_sequence: 2,
    retained_source: { ...f.metadata.retained_source, id: { ...f.metadata.retained_source.id, message_id: "msg_failed" } },
  } });
  const task = { type: "event_msg", payload: { type: "task_started", turn_id: nextTurn } };
  f.rows.push(task); f.save();
  const request = { ...f.options, turnId: nextTurn, compactionSourceTurnId: oldTurnId };
  expect(resolveCurrentCodexRolloutEnvironment(request)?.checkpointSources).toHaveLength(1);
  expect(() => resolveCurrentCodexRolloutEnvironment({ ...request, checkpointSources: undefined })).toThrow();
  task.payload.type = "task_complete"; f.save();
  expect(() => resolveCurrentCodexRolloutEnvironment(request)).toThrow();
  task.payload.type = "task_started"; task.payload.turn_id = oldTurnId; f.save();
  expect(() => resolveCurrentCodexRolloutEnvironment(request)).toThrow();
});

test("checkpoint digest survives telemetry, later native turns, and a fresh resolution while current proof stays mandatory", () => {
  const f = fixture();
  const initial = resolveCurrentCodexRolloutEnvironment(f.options)?.checkpointSources?.[0];
  f.rows.push({ type: "event_msg", payload: { type: "token_count", tokens: 100 } }); f.save();
  expect(resolveCurrentCodexRolloutEnvironment(f.options)?.checkpointSources?.[0]?.sourceHash).toBe(initial?.sourceHash);
  f.rows.push({ type: "turn_context", payload: { ...f.context.payload, turn_id: oldTurnId } }); f.save();
  const nextOptions = { ...f.options, turnId: oldTurnId };
  const next = resolveCurrentCodexRolloutEnvironment(nextOptions)?.checkpointSources?.[0];
  expect(next?.sourceHash).toBe(initial?.sourceHash);
  expect(next?.messages).toEqual(initial?.messages);
  const restarted = spawnSync(process.execPath, ["--eval", `
    const { resolveCurrentCodexRolloutEnvironment } = await import(${JSON.stringify(new URL("../src/adapters/chatgpt-web/codex-rollout-environment.ts", import.meta.url).href)});
    const result = resolveCurrentCodexRolloutEnvironment(${JSON.stringify(nextOptions)});
    process.stdout.write(JSON.stringify(result.checkpointSources[0]));
  `], { encoding: "utf8" });
  expect(restarted.status).toBe(0);
  expect(JSON.parse(restarted.stdout)).toEqual(next);
  expect(() => resolveCurrentCodexRolloutEnvironment(f.options)).toThrow();
});

test("checkpoint digest changes when authenticated original evidence changes", () => {
  const f = fixture();
  const initial = resolveCurrentCodexRolloutEnvironment(f.options)?.checkpointSources?.[0]?.sourceHash;
  f.original.content[0]!.text += " A new source fact.";
  f.compacted.payload.replacement_history[0] = structuredClone(f.original);
  f.save();
  expect(resolveCurrentCodexRolloutEnvironment(f.options)?.checkpointSources?.[0]?.sourceHash).not.toBe(initial);
});

test("a single trusted home or a prior successful resolution cannot supply missing proof", () => {
  const f = fixture(); resolveCurrentCodexRolloutEnvironment(f.options); rmSync(f.path);
  expect(() => resolveCurrentCodexRolloutEnvironment(f.options)).toThrow();
});

test.each(["ciphertext", "id", "superseded"])("rejects mismatched checkpoint %s", mismatch => {
  const f = fixture();
  if (mismatch === "ciphertext") f.options.checkpointSources[0]!.encryptedContent = "wrong";
  if (mismatch === "id") f.options.checkpointSources[0]!.itemId = "cmp_stale";
  if (mismatch === "superseded") f.compacted.payload.replacement_history.pop();
  f.save(); expect(() => resolveCurrentCodexRolloutEnvironment(f.options)).toThrow();
});

test("rejects duplicate trusted-home ownership", () => {
  const f = fixture(); const other = fixture();
  expect(() => resolveCurrentCodexRolloutEnvironment({ ...f.options, additionalCodexHomes: [other.options.codexHome] })).toThrow();
});

test("a checkpoint is resolved by ciphertext without itemId only when its latest identity is unique", () => {
  const f = fixture();
  expect(resolveCurrentCodexRolloutEnvironment({ ...f.options, checkpointSources: [{ encryptedContent: f.checkpoint.encrypted_content }] })?.checkpointSources).toHaveLength(1);
  f.compacted.payload.replacement_history.push(structuredClone(f.checkpoint));
  f.compacted.payload.replacement_history_metadata.push({ history_sequence: 3, sampled_through_sequence: 1 });
  f.save();
  expect(() => resolveCurrentCodexRolloutEnvironment(f.options)).toThrow();
});

test("unsupported content fails explicitly instead of becoming an opaque note or an empty historical message", () => {
  const f = fixture();
  f.rows[1]!.payload = { ...f.original, content: [{ type: "encrypted_content", encrypted_content: "unreadable-original" }] };
  f.save();
  expect(() => resolveCurrentCodexRolloutEnvironment(f.options)).toThrow();
});

test.each(["revision", "order", "incomplete", "unproven-answer"])("rejects retained context with unsupported %s", mutation => {
  const f = fixture();
  f.rows[2]!.payload = { ...f.compacted.payload, retained_context: {
    incomplete: mutation === "incomplete", user_messages_incomplete: false, assistant_messages_incomplete: false,
    user_messages: [{ message_id: f.original.id, turn_id: oldTurnId, revision: mutation === "revision" ? "wrong" : "rev_original", order: mutation === "order" ? 100 : 0, text: f.original.content[0]!.text, complete: true }],
    assistant_messages: [], verified_answers: mutation === "unproven-answer" ? [{ text: "answer without source proof" }] : [],
  } };
  f.save();
  expect(() => resolveCurrentCodexRolloutEnvironment(f.options)).toThrow();
});

test.each(["prefix", "revision", "sequence", "rollback", "unknown", "partial"])("rejects incomplete or unsupported native source %s", mutation => {
  const f = fixture();
  if (mutation === "prefix") f.rows.splice(1, 1);
  if (mutation === "revision") f.compacted.payload.replacement_history_metadata[0] = { ...f.metadata, retained_source: { ...f.metadata.retained_source, revision: "different-revision" } };
  if (mutation === "sequence") f.metadata.history_sequence = 3;
  if (mutation === "rollback") f.rows.push({ type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } });
  if (mutation === "unknown") f.rows.push({ type: "branch_switch", payload: {} });
  f.save();
  if (mutation === "partial") writeFileSync(f.path, readFileSync(f.path, "utf8") + '{"type":"compacted"');
  expect(() => resolveCurrentCodexRolloutEnvironment(f.options)).toThrow();
});

test("later source chronology and local tool call/result relationships survive another compaction", () => {
  const f = fixture();
  const later = { ...f.original, id: "msg_steering", content: [{ type: "input_text", text: "New steering after the original mission." }] };
  const next = { ...f.checkpoint, id: "cmp_second", encrypted_content: "second-ciphertext" };
  f.rows.push(
    { type: "response_item", payload: later, metadata: { history_sequence: 3 } },
    { type: "response_item", payload: { type: "function_call", call_id: "call_local", name: "exec_command", arguments: '{"cmd":"pwd"}' }, metadata: { history_sequence: 4 } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "call_local", output: "local directory evidence" }, metadata: { history_sequence: 5 } },
    { type: "compacted", payload: { replacement_history: [next], replacement_history_metadata: [{ history_sequence: 6 }] } },
  );
  f.save();
  const result = resolveCurrentCodexRolloutEnvironment({ ...f.options, checkpointSources: [{ encryptedContent: next.encrypted_content, itemId: next.id }] });
  expect(result?.checkpointSources?.[0]?.messages.map(m => m.role)).toEqual(["user", "user", "assistant", "toolResult"]);
  expect(JSON.stringify(result?.checkpointSources?.[0]?.messages)).toContain("mission_code=NORTHSTAR");
  expect(result?.checkpointSources?.[0]?.messages.at(-1)).toMatchObject({ toolName: "exec_command", toolCallId: "call_local", content: "local directory evidence" });
});

test("authentic pre-recall native shape recovers the mission from original rows and replacement metadata", () => {
  const f = fixture();
  const snapshot = readFileSync(new URL("./fixtures/native-pre-recall-compaction.jsonl", import.meta.url), "utf8")
    .replaceAll("REPLACE_WITH_TEST_HOME", f.options.codexHome.replaceAll("\\", "\\\\"));
  writeFileSync(f.path, snapshot);
  const options = { ...f.options, checkpointSources: [{ encryptedContent: "authentic-native-opaque-checkpoint-fixture", itemId: "cmp_03260c7bb994c43a016af95686211487d0ba16c71e192f5523" }] };
  const source = resolveCurrentCodexRolloutEnvironment(options)?.checkpointSources?.[0];
  const text = JSON.stringify(source?.messages);
  expect(text).toContain("target_file=proof.txt; required_content=continuity-ok");
  expect(text.match(/Remember this durable task fact/g)).toHaveLength(1);
  expect(text).not.toContain("opaque compaction");
  expect(text).not.toContain("batch 5"); // The caller already owns the post-checkpoint tail.
  expect(source?.messages).toHaveLength(14);
});
