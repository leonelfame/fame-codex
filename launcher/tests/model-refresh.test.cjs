const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createModelRefresh } = require("../electron/model-refresh.cjs");
const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");

const capabilities = { solAvailable: true, extraHighAvailable: true, proAvailable: true };
function fixture(inspectSession) {
  const saved = [];
  const browserHost = { activeTraceId: null, currentOperation: () => null, inspectSession };
  const runtimeHost = { currentOperation: () => null, runtimeConfigSnapshot: () => ({ configured: true, config: { browserInteractionMode: "automatic" } }) };
  return { saved, browserHost, runtimeHost, run: createModelRefresh({ browserHost, runtimeHost, supervisor: { refreshModelCapabilities: async value => saved.push(value) } }) };
}

test("detection failures and malformed evidence preserve the existing configuration", async () => {
  for (const inspect of [async () => { throw Error("Sign in to ChatGPT"); }, async () => ({}), async () => ({ ...capabilities, solAvailable: false })]) {
    const f = fixture(inspect);
    await assert.rejects(f.run);
    assert.deepEqual(f.saved, []);
  }
});

test("busy browser and concurrent detection are refused", async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  f.browserHost.activeTraceId = "active";
  await assert.rejects(f.run, /Finish/);
  f.browserHost.activeTraceId = null;
  const pending = f.run();
  await assert.rejects(f.run, /already running/);
  finish(capabilities);
  assert.deepEqual(await pending, capabilities);
  assert.deepEqual(f.saved, [capabilities]);
});

test("a failed detection can be retried and manual mode does not inspect the page", async () => {
  let attempts = 0;
  const f = fixture(async () => {
    if (++attempts === 1) throw Error("Sign in to ChatGPT");
    return capabilities;
  });
  await assert.rejects(f.run, /Sign in/);
  assert.deepEqual(await f.run(), capabilities);
  f.runtimeHost.runtimeConfigSnapshot = () => ({ configured: true, config: { browserInteractionMode: "manual" } });
  await assert.rejects(f.run, /With Automation/);
  assert.equal(attempts, 2);
});

test("applying models updates only capability flags and never stops the runtime", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fame-model-refresh-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "config.json");
  const original = { solAvailable: false, extraHighAvailable: false, proAvailable: false, customSetting: "preserved" };
  fs.writeFileSync(configPath, JSON.stringify(original));
  const context = {
    configPath, readConfig: () => original, logger: { info() {}, warn() {} },
    control: async (_config, action, { body }) => {
      assert.equal(action, "model-capabilities");
      return { status: "ok", capabilities: body };
    },
  };
  await RuntimeSupervisor.prototype.refreshModelCapabilities.call(context, capabilities);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath)), { ...original, ...capabilities });
  fs.writeFileSync(configPath, JSON.stringify(original));
  context.control = async () => { throw Error("Bridge unavailable"); };
  await assert.rejects(() => RuntimeSupervisor.prototype.refreshModelCapabilities.call(context, capabilities), /previous settings restored/);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath)), original);
});
