import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { createAiPassAdapter } from "../src/adapters/aipass";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";

test("the bundled bridge delivers an isolated temporary turn through the extension protocol", async () => {
  const port = await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Missing test port"));
      server.close(() => resolvePort(address.port));
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [resolve("launcher/assets/aipass/bridge/server.mjs")], {
    env: { ...process.env, AIPASS_HOST: "127.0.0.1", AIPASS_PORT: String(port), AIPASS_MODELS: "" },
    stdio: "ignore", windowsHide: true,
  });
  const controller = new AbortController();
  const jobs: Array<Record<string, unknown>> = [];
  try {
    let connected = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(`${origin}/health`)).ok) { connected = true; break; } } catch {}
      await Bun.sleep(50);
    }
    expect(connected).toBe(true);
    const extension = await fetch(`${origin}/ext/events`, { signal: controller.signal });
    expect(extension.body).not.toBeNull();
    const reader = extension.body!.getReader();
    const ready = Promise.withResolvers<void>();
    const pump = (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (event.startsWith("event: ready")) ready.resolve();
          if (!event.startsWith("event: job")) continue;
          const line = event.split("\n").find(part => part.startsWith("data: "));
          if (!line) throw new Error("Missing extension job data");
          const job = JSON.parse(line.slice(6)) as Record<string, unknown>;
          jobs.push(job);
          let route: string;
          let body: Record<string, unknown>;
          if (job.kind === "create") {
            route = "loader";
            body = { jobId: job.jobId, raw: JSON.stringify([{ _1: 2 }, "id", "temporary-test-id"]) };
          } else if (job.kind === "chat") {
            await fetch(`${origin}/ext/chunk`, { method: "POST", body: JSON.stringify({ jobId: job.jobId, parts: [{ kind: "text", text: "Bridge connected" }] }) });
            route = "done";
            body = { jobId: job.jobId, finishReason: "stop" };
          } else {
            route = "error";
            body = { jobId: job.jobId, message: "fixture loader unavailable" };
          }
          await fetch(`${origin}/ext/${route}`, { method: "POST", body: JSON.stringify(body) });
        }
      }
    })().catch(error => { if (!controller.signal.aborted) throw error; });
    await ready.promise;
    const parsed: CodexParsedRequest = {
      modelId: "aipass/test-model", stream: true, options: {},
      context: { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
    };
    const events: AdapterEvent[] = [];
    await createAiPassAdapter({ bridgeUrl: origin, model: "test-model" }).runTurn!(parsed, { headers: new Headers() }, event => events.push(event));
    expect(events.filter(event => event.type === "text_delta").map(event => event.text).join("")).toBe("Bridge connected");
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop" });
    expect(jobs.find(job => job.kind === "create")).toMatchObject({ temporary: true });
    expect(jobs.find(job => job.kind === "chat")).toMatchObject({ temporary: true, conversationId: "temporary-test-id" });
    controller.abort();
    await pump;
  } finally {
    controller.abort();
    child.kill();
  }
}, 15_000);
