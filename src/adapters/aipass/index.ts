import { z } from "zod";
import type { ProviderAdapter } from "../base";
import type { AdapterEvent } from "../../types";
import { AiPassError, prepareTurn } from "./protocol";

const healthSchema = z.object({
  ok: z.literal(true),
  capabilities: z.object({ isolatedTurns: z.literal(true), automaticRetries: z.literal(false) }),
});
const chunkSchema = z.object({
  choices: z.array(z.object({
    index: z.literal(0),
    delta: z.object({ role: z.literal("assistant").optional(), content: z.string().nullable().optional(), reasoning_content: z.string().optional() }).strict(),
    finish_reason: z.enum(["stop", "length"]).nullable(),
  })).length(1),
});

function bridgeOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("AI Pass bridgeUrl must be an HTTP loopback IP origin without credentials, path, query or fragment");
  }
  return url.origin;
}

async function* sseData(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let data: string[] = [];
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      pending += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        if (!line) {
          if (data.length) yield data.join("\n");
          data = [];
        } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (next.done) {
        if (pending || data.length) throw new AiPassError("Truncated SSE record");
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Experimental WEB wrapper. Tool framing is model-mediated; fixture success is not live provider proof. */
export function createAiPassAdapter({ bridgeUrl, model }: { bridgeUrl: string; model: string }): ProviderAdapter {
  const origin = bridgeOrigin(bridgeUrl);
  if (!model.trim() || model !== model.trim()) throw new Error("AI Pass requires an explicit bridge model");
  return {
    name: "aipass-experimental",
    async runTurn(parsed, incoming, emit) {
      const signal = incoming.abortSignal ?? new AbortController().signal;
      const heartbeat = setInterval(() => emit({ type: "heartbeat" }), 10_000);
      try {
        const turn = prepareTurn(parsed);
        const request = async (path: string, body?: unknown) => {
          signal.throwIfAborted();
          const response = await fetch(`${origin}${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: body === undefined ? {} : { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal,
            redirect: "error",
          });
          if (!response.ok) {
            await response.body?.cancel();
            throw new AiPassError(`AI Pass bridge ${path} returned HTTP ${response.status}`, "aipass_bridge_http_error", response.status);
          }
          return response;
        };
        const health = healthSchema.safeParse(await (await request("/health")).json());
        if (!health.success) throw new AiPassError("Bridge does not support isolated temporary turns", "aipass_bridge_isolation_unproven", 503);
        const response = await request("/v1/chat/isolated", { model, stream: true, messages: [{ role: "user", content: turn.prompt }] });
        if (!response.headers.get("content-type")?.startsWith("text/event-stream") || !response.body) {
          await response.body?.cancel();
          throw new AiPassError("Bridge did not return an SSE stream");
        }
        let finish: "stop" | "length" | undefined;
        let done = false;
        for await (const data of sseData(response.body, signal)) {
          if (data === "[DONE]") { done = true; break; }
          const raw: unknown = JSON.parse(data);
          if (raw && typeof raw === "object" && "error" in raw) {
            const failure = z.object({ error: z.object({ message: z.string() }) }).safeParse(raw);
            // The bridge diagnostic may contain upstream originalText (the full private prompt).
            const diagnostic = failure.success ? failure.data.error.message : "";
            const status = diagnostic.match(/aipass returned (\d{3})\b/)?.[1];
            const policy = diagnostic.includes('"code":"CHAT_RAI_VIOLATION"');
            throw new AiPassError(policy
              ? "TH AI Pass rejected the Codex context: Content Policy Violation (HTTP 422, CHAT_RAI_VIOLATION)."
              : `AI Pass bridge reported a streamed error${status ? ` (upstream HTTP ${status})` : ""}.`, "aipass_upstream_error");
          }
          const chunk = chunkSchema.parse(raw);
          if (finish) throw new AiPassError("Bridge sent output after a terminal finish reason");
          const choice = chunk.choices[0];
          if (choice.delta.reasoning_content && !parsed.options.hideThinkingSummary) emit({ type: "thinking_delta", thinking: choice.delta.reasoning_content });
          if (choice.delta.content) turn.push(choice.delta.content, emit);
          if (choice.finish_reason) finish = choice.finish_reason;
        }
        signal.throwIfAborted();
        if (!done || !finish) throw new AiPassError("Bridge stream ended without finish_reason and [DONE]");
        // Never trust reference usage estimates; stream events intentionally carry no usage.
        turn.finish(finish, emit);
      } catch (error) {
        const event: AdapterEvent = {
          type: "error",
          message: error instanceof Error ? error.message : "AI Pass turn failed",
          code: signal.aborted ? "aipass_cancelled" : error instanceof AiPassError ? error.code : "aipass_protocol_error",
          status: signal.aborted ? 499 : error instanceof AiPassError ? error.status : 502,
          errorType: "server_error",
          retryable: false,
        };
        emit(event);
      } finally {
        clearInterval(heartbeat);
      }
    },
  };
}
