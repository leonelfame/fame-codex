const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function setup(tabs = []) {
  let listener;
  const calls = [];
  const timers = [];
  const event = () => ({ addListener() {} });
  const chrome = {
    runtime: { onMessage: { addListener(fn) { listener = fn; } }, onConnect: event(), onStartup: event(), onInstalled: event() },
    alarms: { create() {}, onAlarm: event() },
    storage: { local: { get: async () => ({}) } },
    tabs: { query: async () => tabs },
  };
  const fetch = (url, options) => {
    if (url.endsWith('/ext/events')) return new Promise(() => {});
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
      calls.push({ path: new URL(url).pathname, body: JSON.parse(options.body), resolve, reject });
    });
  };
  const context = { chrome, fetch, URL, AbortController, TextDecoder, setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; }, clearTimeout: () => {}, console };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/aipass/extension/background.js'), 'utf8'), context);
  return { calls, timers, pickTab: () => context.findChatTab(), send: (payload) => listener({ type: 'from-page', payload }, {}, () => {}) };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('model jobs follow the active or most recently used live chat instead of the oldest tab', async () => {
  const old = { id: 1, url: 'https://de.aipass.net/chat/old', lastAccessed: 1 };
  const recent = { id: 2, url: 'https://de.aipass.net/chat', lastAccessed: 10 };
  assert.equal((await setup([old, recent]).pickTab()).id, 2);
  assert.equal((await setup([{ ...old, active: true }, recent]).pickTab()).id, 1);
  assert.equal((await setup([old, { ...recent, discarded: true }]).pickTab()).id, 1);
  assert.equal(await setup().pickTab(), null);
});

test('delivers each job in order while other jobs proceed', async () => {
  const { calls, send } = setup();
  send({ jobId: 'a', kind: 'chunk', parts: ['first'] });
  send({ jobId: 'a', kind: 'chunk', parts: ['second'] });
  send({ jobId: 'a', kind: 'done', finishReason: 'stop' });
  send({ jobId: 'b', kind: 'error', message: 'failed' });
  await tick();
  assert.deepEqual(calls.map(({path, body}) => [path, body.jobId]), [['/ext/chunk', 'a'], ['/ext/error', 'b']]);
  calls[0].resolve({ ok: true });
  await tick();
  assert.equal(calls[2].body.parts[0], 'second');
  calls[2].resolve({ ok: true });
  await tick();
  assert.equal(calls[3].path, '/ext/done');
  calls[1].resolve({ ok: true });
  calls[3].resolve({ ok: true });
});

test('reports a failed chunk and suppresses later chunks and completion', async () => {
  const { calls, send } = setup();
  send({ jobId: 'a', kind: 'chunk', parts: ['first'] });
  send({ jobId: 'a', kind: 'chunk', parts: ['second'] });
  send({ jobId: 'a', kind: 'done', finishReason: 'stop' });
  await tick();
  calls[0].reject(new Error('network failure'));
  await tick();
  assert.equal(calls[1].path, '/ext/error');
  assert.equal(calls[1].body.jobId, 'a');
  calls[1].resolve({ ok: true });
  await tick();
  assert.deepEqual(calls.map(({path}) => path), ['/ext/chunk', '/ext/error']);
});

test('a rejected chunk and failed error report never send a later completion', async () => {
  const { calls, send } = setup();
  send({ jobId: 'a', kind: 'chunk', parts: ['first'] });
  await tick();
  calls[0].resolve({ ok: false, status: 500 });
  await tick();
  assert.equal(calls[1].path, '/ext/error');
  calls[1].reject(new Error('bridge unavailable'));
  await tick();
  send({ jobId: 'a', kind: 'done', finishReason: 'stop' });
  send({ jobId: 'b', kind: 'done', finishReason: 'stop' });
  await tick();
  assert.deepEqual(calls.map(({path, body}) => [path, body.jobId]), [['/ext/chunk', 'a'], ['/ext/error', 'a'], ['/ext/done', 'b']]);
  calls[2].resolve({ ok: true });
});

test('a timed-out chunk reports an error instead of completing', async () => {
  const { calls, timers, send } = setup();
  send({ jobId: 'stalled', kind: 'chunk', parts: ['partial'] });
  send({ jobId: 'stalled', kind: 'done', finishReason: 'stop' });
  await tick();
  timers.find((timer) => timer.ms === 30_000).fn();
  await tick();
  assert.equal(calls[1].path, '/ext/error');
  calls[1].resolve({ ok: true });
  await tick();
  assert.deepEqual(calls.map(({path}) => path), ['/ext/chunk', '/ext/error']);
});
