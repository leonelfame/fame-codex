import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { getConfigDir } from "./config";

export const AIPASS_MODEL_PREFIX = "aipass/";
export const AIPASS_BRIDGE_URL = "http://127.0.0.1:17843";
// Local transport budget; upstream model limits may be lower.
export const AIPASS_PROMPT_TOKEN_BUDGET = 262144;
const settingsSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  models: z.array(z.object({
    id: z.string().trim().min(1).max(256).regex(/^[^\x00-\x1f\x7f]+$/),
    name: z.string().min(1).max(256),
  })).max(256),
  // A local prompt budget, not a claim about the upstream model's capacity.
  contextWindow: z.union([z.literal(16384), z.literal(AIPASS_PROMPT_TOKEN_BUDGET)])
    .transform(() => AIPASS_PROMPT_TOKEN_BUDGET),
});
export type AiPassSettings = z.infer<typeof settingsSchema>;

export function readAiPassSettings(): AiPassSettings {
  const path = join(getConfigDir(), "aipass.json");
  if (!existsSync(path)) return { version: 1, enabled: false, models: [], contextWindow: AIPASS_PROMPT_TOKEN_BUDGET };
  return settingsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function isAiPassModel(model: unknown): model is string {
  return typeof model === "string" && model.startsWith(AIPASS_MODEL_PREFIX);
}
