const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { AiPassController } = require("../electron/aipass-controller.cjs");

// An actual disposable HTTP child, not a simulated ChildProcess or mocked fetch.
const CHILD_SCRIPT = `
const http = require('node:http');
let state = JSON.parse(process.env.FIXTURE_STATE || '{}');
let modelsRequests = 0;
const server = http.createServer(async (req, res) => {
  if (req.url === '/fixture' && req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    Object.assign(state, JSON.parse(body)); res.end('{}'); return;
  }
  if (req.url === '/fixture') {
    res.end(JSON.stringify({ pid: process.pid, modelsRequests,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^aipass_/i.test(key))) })); return;
  }
  if (req.url === '/health') {
    if (state.hangHealth) return;
    if (state.badHealth) { res.end(JSON.stringify({ok:true,extensions:'1'})); return; }
    res.end(JSON.stringify({ok:true,extensions:state.extensions ?? 0,
      conversation:'private-history',assistant:'private-assistant',credits:{private:true},
      defaultModel:'fictional-default',models:[{id:'fictional-fallback',kind:'chat'}]})); return;
  }
  if (req.url === '/v1/models?refresh=1') {
    modelsRequests++;
    if (state.hangModels) return;
    if (state.delayModels) await new Promise(resolve => setTimeout(resolve, state.delayModels));
    if (state.disconnectOnModels) state.extensions = 0;
    if (state.largeModels) { res.end('x'.repeat(300000)); return; }
    res.end(state.badModels ? 'not-json' : JSON.stringify({object:'list',data:state.models ?? []})); return;
  }
  res.statusCode = 404; res.end('{}');
});
server.listen(Number(process.env.AIPASS_PORT), process.env.AIPASS_HOST);
`;

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function fixtureRequest(port, state) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: "/fixture",
      method: state ? "POST" : "GET", agent: false,
    }, (res) => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve(JSON.parse(body)));
    });
    req.on("error", reject);
    req.setTimeout(2000, () => req.destroy(new Error("Fixture request timed out")));
    req.end(state ? JSON.stringify(state) : undefined);
  });
}

async function fixture(t, state = {}, options = {}) {
  const port = await freePort();
  const children = [];
  let invocations = 0;
  const controller = new AiPassController({
    enabled: true, runtimeExecutable: process.execPath, scriptPath: path.resolve("reviewed-bridge.mjs"),
    port, requestTimeoutMs: 250, startTimeoutMs: 3000, stopTimeoutMs: 500,
    ...options,
    spawnProcess(executable, args, spawnOptions) {
      invocations++;
      assert.equal(executable, process.execPath);
      assert.deepEqual(args, [path.resolve("reviewed-bridge.mjs")]);
      assert.equal(spawnOptions.shell, false);
      assert.equal(spawnOptions.windowsHide, true);
      const child = spawn(process.execPath, ["-e", CHILD_SCRIPT], {
        ...spawnOptions, env: { ...spawnOptions.env, FIXTURE_STATE: JSON.stringify(state) },
      });
      children.push(child);
      return child;
    },
  });
  t.after(async () => {
    await controller.stop();
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once("exit", resolve));
        child.kill("SIGKILL");
        await exited;
      }
    }
  });
  return { controller, port, children, invocations: () => invocations };
}

test("disabled by default: start/refresh/stop neither spawn nor contact a listener", async () => {
  const controller = new AiPassController({ spawnProcess() { assert.fail("must be opt-in"); } });
  assert.equal((await controller.start()).status, "disabled");
  assert.deepEqual(await controller.refresh(), controller.snapshot());
  assert.equal((await controller.stop()).status, "disabled");
});

test("validates enabled executable paths, port and timeout boundaries", () => {
  assert.throws(() => new AiPassController({ enabled: true, runtimeExecutable: "bun", scriptPath: "server.mjs" }));
  assert.throws(() => new AiPassController({ port: 0 }));
  assert.throws(() => new AiPassController({ requestTimeoutMs: 0 }));
  assert.throws(() => new AiPassController({ enabled: "true" }));
  assert.equal(new AiPassController().snapshot().port, 17843);
});

test("model discovery can outlast the health request timeout", async (t) => {
  const f = await fixture(t, { extensions: 1, delayModels: 400, models: [{ id: "chat", name: "Chat", kind: "chat" }] }, { modelTimeoutMs: 1500 });
  const status = await f.controller.start();
  assert.equal(status.status, "running");
  assert.deepEqual(status.models, [{ id: "chat", name: "Chat", kind: "chat" }]);
});

test("real child receives enforced environment; disconnected health never exposes fallback/account data", async (t) => {
  const inherited = { ...process.env, AIPASS_HOST: "0.0.0.0", AIPASS_ADMIN: "1",
    AIPASS_CORS_ORIGIN: "*", AIPASS_MODELS: "invented", AIPASS_MODEL: "inherited-model",
    AIPASS_CONVERSATION_ID: "inherited-conversation", AIPASS_ASSISTANT_ID: "inherited-assistant",
    AIPASS_ASSISTANT_FIELD: "inherited-field", AIPASS_ALLOWED_HOSTS: "evil.example",
    aipass_conversation_id: "case-variant", NODE_OPTIONS: "--invalid-option",
  };
  const f = await fixture(t, {}, { env: inherited });
  const status = await f.controller.start();
  assert.equal(status.status, "running");
  assert.equal(status.extensionConnected, false);
  assert.deepEqual(status.models, []);
  const observed = await fixtureRequest(f.port);
  assert.equal(observed.modelsRequests, 0);
  assert.deepEqual(observed.env, { AIPASS_HOST: "127.0.0.1", AIPASS_PORT: String(f.port),
    AIPASS_ADMIN: "0", AIPASS_CORS_ORIGIN: "", AIPASS_MODELS: "", AIPASS_MODEL_FILTER: "chat" });
  assert.equal(inherited.AIPASS_ADMIN, "1");
  assert.doesNotMatch(JSON.stringify(status), /private|fictional|conversation|assistant|credits|token/i);
});

test("connected catalog uses live endpoint, filters capabilities/fallbacks, and returns defensive snapshots", async (t) => {
  const f = await fixture(t, { extensions: 1, models: [
    { id: "real-chat", name: "Chat", kind: "chat", history: "private",
      thinking: ["low", "medium", "high", "max", "unknown", "medium"] },
    { id: "real-text", name: "Text", kind: "text" },
    { id: "real-chat", name: "Duplicate", kind: "chat" },
    ...["image", "video", "music", "research"].map(kind => ({ id: kind, kind })),
    { id: "fallback", kind: "chat", fallback: true },
    { id: "fallback-source", kind: "chat", source: "fallback" },
    { id: "missing-kind" }, { id: "unready", kind: "chat", ready: false },
    { id: "unselectable", kind: "chat", selectable: false },
  ] });
  const status = await f.controller.start();
  assert.equal(status.extensionConnected, true);
  assert.deepEqual(status.models, [
    { id: "real-chat", name: "Chat", kind: "chat", thinking: ["low", "medium", "high", "max"] },
    { id: "real-text", name: "Text", kind: "text" },
  ]);
  assert.equal((await fixtureRequest(f.port)).modelsRequests, 1);
  status.models[0].id = "changed";
  status.models[0].thinking.push("changed");
  status.models.push({ id: "injected" });
  assert.equal(f.controller.snapshot().models.length, 2);
  assert.equal(f.controller.snapshot().models[0].id, "real-chat");
  assert.deepEqual(f.controller.snapshot().models[0].thinking, ["low", "medium", "high", "max"]);
  await fixtureRequest(f.port, { extensions: 0 });
  assert.deepEqual((await f.controller.refresh()).models, []);
  assert.equal((await fixtureRequest(f.port)).modelsRequests, 1);
});

test("extension disconnection during catalog read clears models", async (t) => {
  const f = await fixture(t, { extensions: 1, disconnectOnModels: true, models: [{ id: "chat", kind: "chat" }] });
  const status = await f.controller.start();
  assert.equal(status.extensionConnected, false);
  assert.deepEqual(status.models, []);
});

test("parallel starts are idempotent; stop/start races finish without extra owned children", async (t) => {
  const f = await fixture(t);
  const states = await Promise.all([f.controller.start(), f.controller.start(), f.controller.start()]);
  assert.ok(states.every(state => state.status === "running"));
  assert.equal(f.invocations(), 1);
  const pid = (await fixtureRequest(f.port)).pid;
  assert.equal(pid, f.children[0].pid);
  const stopped = f.controller.stop();
  const restarted = f.controller.start();
  assert.equal((await stopped).status, "stopped");
  assert.equal((await restarted).status, "running");
  assert.equal(f.invocations(), 2);
  assert.notEqual((await fixtureRequest(f.port)).pid, pid);
  assert.equal((await f.controller.stop()).status, "stopped");
  assert.equal((await f.controller.stop()).status, "stopped");
});

test("occupied port is not adopted, inspected or stopped", async (t) => {
  let requests = 0;
  const foreign = http.createServer((_req, res) => { requests++; res.end('{"ok":true,"extensions":1}'); });
  await new Promise(resolve => foreign.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => foreign.close(resolve)));
  const controller = new AiPassController({ enabled: true, runtimeExecutable: process.execPath,
    scriptPath: path.resolve("reviewed-bridge.mjs"), port: foreign.address().port,
    spawnProcess() { assert.fail("must not spawn over a foreign listener"); },
  });
  assert.equal((await controller.start()).error, "port_unavailable");
  await controller.refresh();
  await controller.stop();
  assert.equal(requests, 0);
  assert.equal(foreign.listening, true);
});

test("unexpected owned child exit is visible and later foreign listener survives stop", async (t) => {
  const f = await fixture(t);
  await f.controller.start();
  const child = f.children[0];
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
  assert.equal(f.controller.snapshot().error, "child_exited");
  const foreign = http.createServer((_req, res) => res.end("foreign"));
  await new Promise(resolve => foreign.listen(f.port, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => foreign.close(resolve)));
  await f.controller.stop();
  assert.equal(foreign.listening, true);
  assert.equal((await f.controller.start()).error, "port_unavailable");
});

test("failed executable launch settles with sanitized error and can be stopped", async () => {
  const controller = new AiPassController({ enabled: true,
    runtimeExecutable: path.resolve("nonexistent-aipass-runtime"), scriptPath: path.resolve("bridge.mjs"),
    port: await freePort(), startTimeoutMs: 200,
  });
  assert.equal((await controller.start()).error, "spawn_failed");
  assert.equal((await controller.stop()).status, "stopped");
});

test("startup deadline cleans up its own unresponsive real child", async (t) => {
  const f = await fixture(t, { hangHealth: true }, { startTimeoutMs: 350, requestTimeoutMs: 60 });
  assert.equal((await f.controller.start()).error, "start_timeout");
  assert.notEqual(f.children[0].signalCode, null);
  assert.equal((await f.controller.stop()).status, "stopped");
});

test("invalid/oversize/slow model replies clear prior models and permit recovery", async (t) => {
  const f = await fixture(t, { extensions: 1, models: [{ id: "real", kind: "chat" }] });
  assert.equal((await f.controller.start()).models.length, 1);
  for (const bad of ["badModels", "largeModels", "hangModels"]) {
    await fixtureRequest(f.port, { [bad]: true });
    const status = await f.controller.refresh();
    assert.equal(status.error, "refresh_failed");
    assert.deepEqual(status.models, []);
    await fixtureRequest(f.port, { [bad]: false });
    assert.equal((await f.controller.refresh()).models.length, 1);
  }
  await fixtureRequest(f.port, { badHealth: true });
  assert.equal((await f.controller.refresh()).error, "invalid_health");
  assert.deepEqual(f.controller.snapshot().models, []);
});
