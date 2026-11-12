import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIPASS_PROMPT_TOKEN_BUDGET, readAiPassSettings } from "../src/aipass-config";

test("legacy and current AiPass settings use the same expanded local budget without losing models", () => {
  const previous = process.env.FAME_CODEX_HOME;
  const directory = mkdtempSync(join(tmpdir(), "aipass-budget-"));
  process.env.FAME_CODEX_HOME = directory;
  try {
    expect(readAiPassSettings().contextWindow).toBe(AIPASS_PROMPT_TOKEN_BUDGET);
    for (const contextWindow of [16384, AIPASS_PROMPT_TOKEN_BUDGET]) {
      writeFileSync(join(directory, "aipass.json"), JSON.stringify({
        version: 1, enabled: true, models: [{ id: "fixture", name: "Fixture" }], contextWindow,
      }));
      expect(readAiPassSettings()).toEqual({
        version: 1, enabled: true, models: [{ id: "fixture", name: "Fixture" }], contextWindow: AIPASS_PROMPT_TOKEN_BUDGET,
      });
    }
  } finally {
    if (previous === undefined) delete process.env.FAME_CODEX_HOME;
    else process.env.FAME_CODEX_HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("AiPass settings retain supported effort metadata and accept legacy entries", () => {
  const previous = process.env.FAME_CODEX_HOME;
  const directory = mkdtempSync(join(tmpdir(), "aipass-effort-"));
  process.env.FAME_CODEX_HOME = directory;
  try {
    writeFileSync(join(directory, "aipass.json"), JSON.stringify({
      version: 1, enabled: true, contextWindow: AIPASS_PROMPT_TOKEN_BUDGET,
      models: [{ id: "with-effort", name: "With effort", thinking: ["low", "medium", "high", "max"] },
        { id: "legacy", name: "Legacy" }],
    }));
    expect(readAiPassSettings().models).toEqual([
      { id: "with-effort", name: "With effort", thinking: ["low", "medium", "high", "max"] },
      { id: "legacy", name: "Legacy" },
    ]);
  } finally {
    if (previous === undefined) delete process.env.FAME_CODEX_HOME;
    else process.env.FAME_CODEX_HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
