import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { atomicWriteFile } from "../../config";
import { decodeCompactionSummary, SUMMARY_PREFIX } from "../../responses/compaction";
import type { CodexParsedRequest } from "../../types";

const checkpointItem = z.object({
  type: z.enum(["compaction", "compaction_summary", "context_compaction"]),
  id: z.string().optional(), encrypted_content: z.string().min(1),
});
const body = z.object({ input: z.array(z.unknown()) });
const storedCheckpoint = z.object({
  version: z.literal(1), ownerThreadId: z.string().min(1), checkpointHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/), summary: z.string().min(1).max(2_000_000),
});

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export function opaqueNativeCheckpoints(parsed: CodexParsedRequest): Array<{ encryptedContent: string; itemId?: string }> {
  const raw = body.safeParse(parsed._rawBody);
  if (!raw.success) return [];
  return raw.data.input.flatMap(item => {
    const checkpoint = checkpointItem.safeParse(item);
    if (!checkpoint.success || decodeCompactionSummary(checkpoint.data.encrypted_content) !== null) return [];
    return [{ encryptedContent: checkpoint.data.encrypted_content, ...(checkpoint.data.id ? { itemId: checkpoint.data.id } : {}) }];
  });
}

export function withReadableNativeCheckpoints(parsed: CodexParsedRequest, summaries: readonly string[]): CodexParsedRequest {
  let index = 0;
  const messages = parsed.context.messages.map(message => {
    if (message.role !== "user" || !message.compactionSource
      || decodeCompactionSummary(message.compactionSource.encryptedContent) !== null) return message;
    const summary = summaries[index++];
    if (summary === undefined) throw new Error("Native checkpoint recovery has incomplete source coverage");
    return { ...message, content: `${SUMMARY_PREFIX}\n\n${summary}` };
  });
  if (index !== summaries.length) throw new Error("Native checkpoint recovery does not match the rendered history");
  return { ...parsed, context: { ...parsed.context, messages } };
}

export class ReadableNativeCheckpointStore {
  constructor(private readonly directory: string) {}

  private path(ownerThreadId: string, encryptedContent: string): string {
    return join(this.directory, `${digest(JSON.stringify([ownerThreadId, digest(encryptedContent)]))}.json`);
  }

  get(ownerThreadId: string, encryptedContent: string, sourceHash: string): string | undefined {
    const path = this.path(ownerThreadId, encryptedContent);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8_000_000) return undefined;
      const saved = storedCheckpoint.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (!saved.success || saved.data.ownerThreadId !== ownerThreadId
        || saved.data.checkpointHash !== digest(encryptedContent) || saved.data.sourceHash !== sourceHash) return undefined;
      return saved.data.summary;
    } catch { return undefined; }
  }

  set(ownerThreadId: string, encryptedContent: string, sourceHash: string, summary: string): void {
    const saved = storedCheckpoint.parse({ version: 1, ownerThreadId, checkpointHash: digest(encryptedContent), sourceHash, summary });
    atomicWriteFile(this.path(ownerThreadId, encryptedContent), JSON.stringify(saved));
  }
}
