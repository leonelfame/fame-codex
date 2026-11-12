const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function runJob(kind, response) {
  let listener;
  let resolveReply;
  const completed = new Promise(resolve => { resolveReply = resolve; });
  const window = {
    location: { origin: 'https://de.aipass.net' },
    addEventListener(_event, callback) { listener = callback; },
    postMessage(message) { if (message.jobId === 'fixture') resolveReply(message); },
  };
  const source = fs.readFileSync(path.join(__dirname, '../assets/aipass/extension/page.js'), 'utf8');
  vm.runInNewContext(source, { window, fetch: async () => response, TextDecoder, URLSearchParams });
  listener({ source: window, data: { __aipass_bridge: 'req', job: {
    jobId: 'fixture', kind, url: '/loaders/list-models.data', temporary: true,
  } } });
  return completed;
}

for (const kind of ['loader', 'create']) {
  test(`${kind} completes from a split UTF-8 JSON record even when HTTP stays open`, { timeout: 2000 }, async () => {
    const record = JSON.stringify([{ name: 'ภาษาไทย', models: ['fixture'] }]);
    const bytes = new TextEncoder().encode(record + '\n');
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 2) controller.enqueue(bytes.slice(i, i + 2));
      },
      cancel() { cancelled = true; },
    });
    const reply = await runJob(kind, new Response(body));
    assert.equal(reply.raw, record);
    assert.equal(cancelled, true);
    assert.equal(reply.message, undefined);
  });
}

test('a closed JSON response without a newline remains supported', async () => {
  assert.equal((await runJob('loader', new Response('[1,2,3]'))).raw, '[1,2,3]');
});

test('temporary chat creation explicitly binds the selected upstream model', async () => {
  let listener;
  let body;
  const window = {
    location: { origin: 'https://de.aipass.net' },
    addEventListener(_name, callback) { listener = callback; },
    postMessage() {},
  };
  const source = fs.readFileSync(path.join(__dirname, '../assets/aipass/extension/page.js'), 'utf8');
  vm.runInNewContext(source, {
    window, URLSearchParams, TextDecoder,
    fetch: async (_url, options) => {
      body = new URLSearchParams(options.body);
      return new Response('[]\n');
    },
  });
  listener({ source: window, data: { __aipass_bridge: 'req', job: {
    jobId: 'model-create', kind: 'create', temporary: true,
    modelId: 'claude-opus-5-5@azure',
  } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(body.get('intent'), 'create-temporary-chat');
  assert.equal(body.get('modelId'), 'claude-opus-5-5@azure');
});

for (const raw of ['[1,2\n', '{"models":[]}\n']) {
  test(`invalid loader records are errors rather than model data: ${raw.trim()}`, async () => {
    const reply = await runJob('loader', new Response(raw));
    assert.equal(reply.raw, undefined);
    assert.equal(typeof reply.message, 'string');
  });
}
