import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadableNativeCheckpointStore, opaqueNativeCheckpoints, withReadableNativeCheckpoints } from "../src/adapters/chatgpt-web/native-checkpoint-recovery";
import { parseRequest } from "../src/responses/parser";
import { encodeCompactionSummary, OPAQUE_COMPACTION_NOTE } from "../src/responses/compaction";

test("opaque recovery matches native checkpoints without treating ordinary user text as proof", () => {
  const input = parseRequest({ model: "gpt-5.6-sol", input: [
    { type: "compaction", id: "cmp_native", encrypted_content: "native-encrypted-state" },
    { type: "compaction", encrypted_content: encodeCompactionSummary("readable prior summary") },
    { role: "user", content: "Continue the original task" },
  ] });
  expect(opaqueNativeCheckpoints(input)).toEqual([{ itemId: "cmp_native", encryptedContent: "native-encrypted-state" }]);
  const before = structuredClone(input);
  const recovered = withReadableNativeCheckpoints(input, ["mission=MISSION-7391"]);
  expect(JSON.stringify(recovered.context.messages)).toContain("mission=MISSION-7391");
  expect(JSON.stringify(recovered.context.messages)).toContain("Continue the original task");
  expect(input).toEqual(before);
  expect(recovered._rawBody).toBe(input._rawBody);
  expect(opaqueNativeCheckpoints(parseRequest({ model: "gpt-5.6-sol", input: [{ role: "user", content: OPAQUE_COMPACTION_NOTE }] }))).toEqual([]);
  expect(() => withReadableNativeCheckpoints(input, [])).toThrow("incomplete source coverage");
  const quoted = parseRequest({ model: "gpt-5.6-sol", input: [
    { role: "user", content: OPAQUE_COMPACTION_NOTE },
    { type: "compaction", encrypted_content: "native-encrypted-state" },
  ] });
  const restored = withReadableNativeCheckpoints(quoted, ["original task facts"]);
  expect(restored.context.messages[0]?.content).toBe(OPAQUE_COMPACTION_NOTE);
  expect(restored.context.messages[1]?.content).toContain("original task facts");
});

test("readable native checkpoints survive restart only for the exact owner and source", () => {
  const directory = mkdtempSync(join(tmpdir(), "fame-native-checkpoint-"));
  try {
    const hash = "a".repeat(64);
    new ReadableNativeCheckpointStore(directory).set("thread-1", "opaque-1", hash, "MISSION-7391");
    const reopened = new ReadableNativeCheckpointStore(directory);
    expect(reopened.get("thread-1", "opaque-1", hash)).toBe("MISSION-7391");
    expect(reopened.get("thread-2", "opaque-1", hash)).toBeUndefined();
    expect(reopened.get("thread-1", "opaque-2", hash)).toBeUndefined();
    expect(reopened.get("thread-1", "opaque-1", "b".repeat(64))).toBeUndefined();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
