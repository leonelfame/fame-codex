import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { startServer } from "../src/server";

test("refresh changes the live catalog without disconnecting an active native stream", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0, solAvailable: false, extraHighAvailable: false, proAvailable: false };
  let source: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = false;
  const server = startServer(config, {
    fetchUpstream: async request => new URL(request.url).pathname.endsWith("/models")
      ? Response.json({ models: [{ slug: "gpt-6-sol", supported_in_api: true, visibility: "list", priority: 1, supported_reasoning_levels: [] }] })
      : new Response(new ReadableStream<Uint8Array>({
        start(controller) { source = controller; controller.enqueue(new TextEncoder().encode("before")); },
        cancel() { cancelled = true; },
      })),
  });
  const endpoint = `http://127.0.0.1:${server.port}`;
  const nativeHeaders = { authorization: "Bearer fixture", "content-type": "application/json" };
  const update = (body: unknown, token = config.controlToken, origin = false) => fetch(`${endpoint}/admin/model-capabilities`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(origin ? { origin: "https://example.com" } : {}) },
    body: JSON.stringify(body),
  });
  const slugs = async () => {
    const response = await fetch(`${endpoint}/v1/models`, { headers: nativeHeaders });
    expect(response.status).toBe(200);
    const body = await response.json();
    return body.models.map((model: { slug: string }) => model.slug);
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    expect(await slugs()).toContain("chatgpt-web/gpt-5.6-luna");
    const response = await fetch(`${endpoint}/v1/alpha/search`, { method: "POST", headers: nativeHeaders, body: JSON.stringify({ query: "stream proof" }) });
    if (!response.body) throw new Error("Missing native stream");
    reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("before");
    const capabilities = { solAvailable: true, extraHighAvailable: true, proAvailable: true };
    expect((await update(capabilities, "wrong")).status).toBe(401);
    expect((await update(capabilities, config.controlToken, true)).status).toBe(403);
    for (const invalid of [null, {}, { ...capabilities, solAvailable: false }, { ...capabilities, proAvailable: "true" }]) {
      expect((await update(invalid)).status).toBe(400);
    }
    expect(await slugs()).toContain("chatgpt-web/gpt-5.6-luna");
    expect((await update(capabilities)).status).toBe(200);
    expect(await slugs()).toContain("chatgpt-web/gpt-6-sol");
    expect(await slugs()).toContain("chatgpt-web/gpt-6-pro");
    expect(await slugs()).not.toContain("chatgpt-web/gpt-5.6-luna");
    expect(await (await fetch(`${endpoint}/healthz`)).json()).toMatchObject({ accepting_turns: true, active_http_turns: 1 });
    expect(cancelled).toBe(false);
    if (!source) throw new Error("Missing native stream source");
    source.enqueue(new TextEncoder().encode("after"));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("after");
    source.close();
    expect((await reader.read()).done).toBe(true);
    expect(config.solAvailable).toBe(false);
  } finally {
    await reader?.cancel();
    await server.stop(true);
  }
});
