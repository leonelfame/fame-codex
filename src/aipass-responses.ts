import { createAiPassAdapter } from "./adapters/aipass";
import { AIPASS_BRIDGE_URL, AIPASS_MODEL_PREFIX, readAiPassSettings } from "./aipass-config";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse } from "./bridge";
import { AsyncEventQueue } from "./event-queue";
import { parseRequest } from "./responses/parser";
import { expandPreviousResponseInput, rememberResponseState } from "./responses/state";
import { namespacedToolName, type AdapterEvent } from "./types";

export async function aiPassResponseRequest(req: Request, raw: unknown): Promise<Response> {
  try {
    const settings = readAiPassSettings();
    if (!settings.enabled) return formatErrorResponse(503, "server_error", "Enable TH AI Pass in Fame Codex Settings first.");
    const expanded = expandPreviousResponseInput(raw);
    const parsed = parseRequest(expanded);
    const model = parsed.modelId.slice(AIPASS_MODEL_PREFIX.length);
    const selected = settings.models.find(row => row.id === model);
    if (!selected) {
      return formatErrorResponse(400, "invalid_request_error", "Unknown TH AI Pass model. Refresh models with the extension connected.");
    }
    const adapter = createAiPassAdapter({ bridgeUrl: AIPASS_BRIDGE_URL, model, thinking: selected.thinking });
    const queue = new AsyncEventQueue<AdapterEvent>();
    const abort = new AbortController();
    const cancel = () => abort.abort(req.signal.reason);
    if (req.signal.aborted) cancel();
    else req.signal.addEventListener("abort", cancel, { once: true });
    const run = async () => {
      try {
        await adapter.runTurn!(parsed, { headers: new Headers(), abortSignal: abort.signal }, event => queue.push(event));
      } catch (error) {
        queue.push({ type: "error", message: error instanceof Error ? error.message : String(error) });
      } finally {
        req.signal.removeEventListener("abort", cancel);
        queue.close();
      }
    };
    const toolNsMap = new Map<string, { namespace: string; name: string }>();
    const freeformToolNames = new Set<string>();
    const toolSearchToolNames = new Set<string>();
    for (const tool of parsed.context.tools ?? []) {
      if (tool.namespace) toolNsMap.set(namespacedToolName(tool.namespace, tool.name), { namespace: tool.namespace, name: tool.name });
      if (tool.freeform) freeformToolNames.add(tool.name);
      if (tool.toolSearch) toolSearchToolNames.add(tool.name);
    }
    const remember = (response: Parameters<typeof rememberResponseState>[1]) => rememberResponseState(expanded, response, { force: true });
    const maps = { toolNsMap, freeformToolNames, toolSearchToolNames, hideThinkingSummary: parsed.options.hideThinkingSummary };
    if (parsed.stream) {
      void run();
      const stream = bridgeToResponsesSSE(queue, parsed.modelId, toolNsMap, freeformToolNames, toolSearchToolNames,
        () => abort.abort(), 2000, { ...maps, onCompletedResponse: remember });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" } });
    }
    await run();
    const response = buildResponseJSON(await queue.collect(), parsed.modelId, maps);
    remember(response);
    return Response.json(response);
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
}
