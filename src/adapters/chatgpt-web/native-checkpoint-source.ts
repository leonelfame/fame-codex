import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import * as z from "zod/v4";
import { parseRequest } from "../../responses/parser";
import type { CodexMessage } from "../../types";

export interface NativeCheckpointRequest {
  encryptedContent: string;
  itemId?: string;
}

export interface NativeCheckpointSource {
  encryptedContent: string;
  messages: CodexMessage[];
  sourceHash: string;
}

const objectSchema = z.record(z.string(), z.unknown());
const retainedSourceSchema = z.object({
  id: z.object({ message_id: z.string().min(1), turn_id: z.string().min(1), role: z.enum(["user", "assistant", "developer", "system"]) }),
  revision: z.string().min(1), complete: z.boolean(),
});
const metadataSchema = z.object({
  history_sequence: z.number().int().positive(),
  sampled_through_sequence: z.number().int().nonnegative().optional(),
  retained_source: retainedSourceSchema.optional(),
}).loose();
const rowSchema = z.object({
  ordinal: z.number().int().nonnegative(), type: z.string(), payload: objectSchema,
  metadata: metadataSchema.optional(),
});
type HistoryMetadata = z.infer<typeof metadataSchema>;
type SourceItem = { item: Record<string, unknown>; metadata: HistoryMetadata };
type Checkpoint = { id: string; encryptedContent: string; source: readonly SourceItem[] };

const passiveEvents = new Set([
  "task_started", "task_complete", "task_completed", "task_aborted", "turn_aborted",
  "thread_settings_applied", "item_completed", "token_count", "user_message",
  "agent_message", "agent_reasoning", "agent_reasoning_raw_content", "agent_reasoning_section_break",
  "warning", "error", "context_compacted",
  "exec_command_begin", "exec_command_end", "exec_command_output_delta",
  "mcp_tool_call_begin", "mcp_tool_call_end", "patch_apply_begin", "patch_apply_end",
]);

function fail(reason: string): never {
  throw new Error(`Native checkpoint source unavailable: ${reason}`);
}

function itemTurn(item: Record<string, unknown>): unknown {
  return objectSchema.safeParse(item.internal_chat_message_metadata_passthrough).data?.turn_id;
}

function sameRetainedRevision(original: SourceItem, next: SourceItem): boolean {
  const a = original.metadata.retained_source;
  const b = next.metadata.retained_source;
  return a !== undefined && b !== undefined && isDeepStrictEqual(a.id, b.id) && a.revision === b.revision;
}

function textOf(item: Record<string, unknown>): string {
  if (typeof item.content === "string") return item.content;
  return z.array(z.object({ text: z.string() }).loose()).parse(item.content).map(part => part.text).join("");
}

function matchesRetainedText(original: string, retained: string, complete: boolean): boolean {
  if (original === retained) return true;
  if (complete) return false;
  const parts = retained.split(/<truncated omitted_approx_tokens="\d+" \/>|…\d+ tokens truncated…/u);
  return parts.length === 2 && original.startsWith(parts[0]!) && original.endsWith(parts[1]!)
    && parts[0]!.length + parts[1]!.length <= original.length;
}

function validateRetainedIdentity(source: SourceItem): void {
  const retained = source.metadata.retained_source;
  if (retained && (retained.id.message_id !== source.item.id || retained.id.role !== source.item.role
    || retained.id.turn_id !== itemTurn(source.item))) fail("retained source identity differs from its original item");
}

function validateReadableItem(item: Record<string, unknown>): void {
  switch (item.type) {
    case "message": {
      if (!["user", "developer", "assistant", "system"].includes(String(item.role))) fail("unsupported message role");
      if (typeof item.content !== "string") {
        if (item.role === "assistant") {
          z.array(z.union([
            z.object({ type: z.enum(["output_text", "text"]), text: z.string() }),
            z.object({ type: z.literal("refusal"), refusal: z.string() }),
          ])).parse(item.content);
        } else {
          z.array(z.union([
            z.object({ type: z.enum(["input_text", "text"]), text: z.string() }),
            z.object({ type: z.literal("input_image"), image_url: z.string().min(1) }),
          ])).parse(item.content);
        }
      }
      return;
    }
    case "additional_tools":
      z.array(z.unknown()).parse(item.tools);
      return;
    case "reasoning":
      if (item.summary !== undefined) z.array(z.object({ type: z.literal("summary_text"), text: z.string() })).parse(item.summary);
      if (item.content !== undefined) z.array(z.object({ type: z.literal("reasoning_text"), text: z.string() })).parse(item.content);
      return;
    case "function_call":
      z.string().min(1).parse(item.name); z.string().min(1).parse(item.call_id);
      if (item.arguments !== undefined && item.arguments !== "") objectSchema.parse(JSON.parse(z.string().parse(item.arguments)));
      return;
    case "custom_tool_call":
      z.string().min(1).parse(item.name); z.string().min(1).parse(item.call_id); z.string().parse(item.input);
      return;
    case "function_call_output":
    case "custom_tool_call_output":
      z.string().min(1).parse(item.call_id);
      z.union([z.string(), z.array(z.union([
        z.object({ type: z.enum(["input_text", "output_text", "text"]), text: z.string() }),
        z.object({ type: z.literal("input_image"), image_url: z.string().min(1) }),
        z.object({ type: z.literal("refusal"), refusal: z.string() }),
      ]))]).parse(item.output);
      return;
    default:
      fail(`unsupported readable item ${String(item.type)}`);
  }
}

function parsedMessages(source: readonly SourceItem[]): CodexMessage[] {
  const calls = new Set<string>();
  const pending = new Set<string>();
  for (const { item } of source) {
    validateReadableItem(item);
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      const id = z.string().parse(item.call_id);
      if (calls.has(id)) fail("duplicate tool call identity");
      calls.add(id); pending.add(id);
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      const id = z.string().parse(item.call_id);
      if (!pending.delete(id)) fail("missing or conflicting tool call prefix");
    }
  }
  if (pending.size) fail("incomplete tool call source");
  const request = parseRequest({
    model: "chatgpt-web/native-checkpoint-source",
    input: source.map(({ item }) => item.type === "message" && item.role === "system" ? { ...item, role: "developer" } : item),
  });
  // Historical tool declarations are parsed for fidelity, but never returned as execution grants.
  return request.context.messages.map(message => ({ ...message, timestamp: 0 }));
}

/** Consumes only bytes from the resolver's authenticated open descriptor. No paths or file access. */
export function recoverNativeCheckpointSources(options: {
  snapshot: Buffer;
  requests: readonly NativeCheckpointRequest[];
  ownerIdentity: string;
  threadId: string;
  turnId: string;
}): NativeCheckpointSource[] {
  if (options.snapshot.at(-1) !== 0x0a) fail("incomplete JSONL snapshot");
  const rows = new TextDecoder("utf-8", { fatal: true }).decode(options.snapshot).trimEnd().split("\n").map(line => {
    if (Buffer.byteLength(line) > 16 * 1024 * 1024) fail("oversized JSONL record");
    return rowSchema.parse(JSON.parse(line));
  });
  const ledger: SourceItem[] = [];
  const bySequence = new Map<number, SourceItem>();
  const byId = new Map<string, SourceItem>();
  const checkpoints = new Map<string, Checkpoint>();
  let sequence = 0;
  let latestHistory: Record<string, unknown>[] = [];
  let latestTurn: unknown;

  const append = (source: SourceItem): void => {
    validateRetainedIdentity(source);
    if (source.metadata.history_sequence !== sequence + 1) fail("missing source prefix or unsupported history sequence mutation");
    if (source.metadata.sampled_through_sequence !== undefined && source.metadata.sampled_through_sequence > sequence) fail("missing sampled source prefix");
    if (typeof source.item.id === "string") {
      if (byId.has(source.item.id)) fail("conflicting source item identity or revision");
      byId.set(source.item.id, source);
    }
    sequence = source.metadata.history_sequence;
    bySequence.set(sequence, source);
    ledger.push(source);
  };

  for (const [ordinal, row] of rows.entries()) {
    if (row.ordinal !== ordinal) fail("missing original ordinal prefix or unsupported branch mutation");
    switch (row.type) {
      case "session_meta":
        if (ordinal !== 0) fail("unsupported imported session ancestry");
        break;
      case "turn_context": latestTurn = row.payload.turn_id; break;
      case "fork_boundary": break;
      case "world_state":
      case "token_usage_record": break;
      case "event_msg":
        if (!passiveEvents.has(String(row.payload.type))) fail(`unsupported history mutation event ${String(row.payload.type)}`);
        break;
      case "response_item":
        if (!row.metadata) fail("missing original history metadata");
        validateReadableItem(row.payload);
        append({ item: row.payload, metadata: row.metadata });
        break;
      case "compacted": {
        const history = z.array(objectSchema).nonempty().parse(row.payload.replacement_history);
        const metadata = z.array(metadataSchema).parse(row.payload.replacement_history_metadata);
        if (!ledger.length || history.length !== metadata.length) fail("missing readable compaction prefix or replacement metadata");
        const source = ledger.slice();
        let createdCheckpoint = false;
        const replacementIds = new Set<string>();
        const replacementSequences = new Set<number>();
        for (const [index, item] of history.entries()) {
          const meta = metadata[index]!;
          if (replacementSequences.has(meta.history_sequence)) fail("duplicate replacement history sequence");
          replacementSequences.add(meta.history_sequence);
          if (typeof item.id === "string") {
            if (replacementIds.has(item.id)) fail("duplicate replacement item identity");
            replacementIds.add(item.id);
          }
          if (item.type === "compaction") {
            const id = z.string().min(1).parse(item.id);
            const encryptedContent = z.string().min(1).parse(item.encrypted_content);
            const previous = checkpoints.get(id);
            if (previous) {
              if (previous.encryptedContent !== encryptedContent || bySequence.get(meta.history_sequence)?.item.id !== id) fail("conflicting checkpoint revision");
            } else {
              if (createdCheckpoint) fail("multiple unexplained compaction checkpoints");
              createdCheckpoint = true;
              checkpoints.set(id, { id, encryptedContent, source });
              append({ item, metadata: meta });
              ledger.pop(); // The checkpoint expands to its readable evidence, never an opaque note.
            }
            continue;
          }
          const original = bySequence.get(meta.history_sequence);
          if (original) {
            const retained = { item, metadata: meta };
            validateRetainedIdentity(retained);
            if (!sameRetainedRevision(original, retained)
              || original.item.id !== item.id || original.item.role !== item.role || itemTurn(original.item) !== itemTurn(item)
              || original.metadata.sampled_through_sequence !== meta.sampled_through_sequence
              || original.metadata.user_input_order !== meta.user_input_order
              || !matchesRetainedText(textOf(original.item), textOf(item), meta.retained_source!.complete)) fail("conflicting retained source identity, revision, or content");
          } else {
            if (meta.retained_source) fail("missing original retained source prefix");
            // Only new native harness updates are understood here. A new task requires response_item proof.
            const kinds = objectSchema.safeParse(item.internal_chat_message_metadata_passthrough).data?.content_item_kinds;
            const environment = item.type === "message" && item.role === "user" && Array.isArray(kinds)
              && kinds.length > 0 && kinds.every(kind => kind === "environments.environment_context");
            if (!(item.type === "additional_tools" || item.type === "message" && item.role === "developer" || environment)) fail("unexplained replacement history mutation");
            validateReadableItem(item);
            append({ item, metadata: meta });
          }
        }
        if (!createdCheckpoint) fail("unsupported replacement without a new checkpoint");
        if (row.payload.retained_context !== undefined) {
          const retained = z.object({
            incomplete: z.literal(false), user_messages_incomplete: z.literal(false), assistant_messages_incomplete: z.literal(false),
            user_messages: z.array(objectSchema), assistant_messages: z.array(objectSchema),
            verified_answers: z.tuple([]).optional(),
          }).loose().parse(row.payload.retained_context);
          const retainedOrders = new Set<number>();
          for (const [role, items] of [["user", retained.user_messages], ["assistant", retained.assistant_messages]] as const) {
            for (const item of items) {
              const original = byId.get(z.string().parse(item.message_id));
              const proof = original?.metadata.retained_source;
              const order = z.number().int().nonnegative().parse(item.order);
              if (!original || !proof || proof.id.role !== role || proof.id.turn_id !== item.turn_id || proof.revision !== item.revision
                || retainedOrders.has(order) || original.metadata.user_input_order !== order
                || !matchesRetainedText(textOf(original.item), z.string().parse(item.text), z.boolean().parse(item.complete))) fail("missing or conflicting retained context source revision");
              retainedOrders.add(order);
            }
          }
        }
        latestHistory = history;
        break;
      }
      default: fail(`unsupported history mutation record ${row.type}`);
    }
  }
  if (latestTurn !== options.turnId) fail("latest native turn does not match requested current turn");
  return options.requests.map(request => {
    if (!request.encryptedContent || request.itemId === "") fail("invalid requested checkpoint identity");
    const matches = latestHistory.filter(item => item.type === "compaction" && item.encrypted_content === request.encryptedContent
      && (request.itemId === undefined || item.id === request.itemId));
    if (matches.length !== 1) fail("requested checkpoint differs from latest native compaction");
    const id = z.string().parse(matches[0]!.id);
    const checkpoint = checkpoints.get(id);
    if (!checkpoint || checkpoint.encryptedContent !== request.encryptedContent || !checkpoint.source.length) fail("missing original readable checkpoint prefix");
    const messages = parsedMessages(checkpoint.source);
    if (!messages.length) fail("missing original readable checkpoint messages");
    return {
      encryptedContent: request.encryptedContent,
      messages,
      sourceHash: createHash("sha256").update(JSON.stringify([
        "native-checkpoint-source-v1", options.ownerIdentity, options.threadId, id, request.encryptedContent, checkpoint.source,
      ])).digest("hex"),
    };
  });
}
