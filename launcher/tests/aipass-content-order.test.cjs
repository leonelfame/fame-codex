const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

const source = (name) => fs.readFileSync(path.join(__dirname, '../assets/aipass/extension', name), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const event = () => ({ addListener() {} });

function setup(transport) {
  let backgroundListener, pageListener;
  const posts = [], pageMessages = [], attempts = [];
  const backgroundChrome = {
    runtime: { onMessage: { addListener(fn) { backgroundListener = fn; } }, onConnect: event(), onStartup: event(), onInstalled: event() },
    alarms: { create() {}, onAlarm: event() },
    storage: { local: { get: async () => ({}) } },
    tabs: { query: async () => [] },
  };
  const fetch = async (url, options) => {
    if (url.endsWith('/ext/events')) return new Promise(() => {});
    posts.push({ path: new URL(url).pathname, body: JSON.parse(options.body) });
    return { ok: true };
  };
  vm.runInNewContext(source('background.js'), { chrome: backgroundChrome, fetch, URL, AbortController, TextDecoder, setTimeout: () => 1, clearTimeout() {}, console });
  const window = { location: { origin: 'https://de.aipass.net' }, addEventListener(_name, fn) { pageListener = fn; }, postMessage(msg) { pageMessages.push(msg); } };
  const chrome = { runtime: {
    onMessage: event(),
    connect: () => ({ onDisconnect: event(), postMessage() {}, disconnect() {} }),
    sendMessage: async (msg) => {
      attempts.push(msg);
      const deliver = () => { let response; backgroundListener(msg, {}, (value) => { response = value; }); return response; };
      return transport(msg, attempts, deliver);
    },
  } };
  vm.runInNewContext(source('content.js'), { window, chrome, crypto: { randomUUID }, setTimeout: (fn, ms) => ms < 2000 ? setImmediate(fn) : 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, console });
  return { posts, attempts, pageMessages, send: (payload) => pageListener({ source: window, data: { __aipass_bridge: 'res', ...payload } }) };
}

async function settle() { for (let i = 0; i < 30; i++) await tick(); }

test('retries in order, deduplicates a lost acknowledgement, and lets another job proceed', async () => {
  let failedBefore = false, lostAck = false;
  const h = setup((msg, _attempts, deliver) => {
    if (msg.payload.jobId === 'a' && !failedBefore) { failedBefore = true; throw Error('not delivered'); }
    if (msg.payload.jobId === 'a' && !lostAck) { lostAck = true; deliver(); throw Error('ack lost'); }
    return deliver();
  });
  h.send({ jobId: 'a', kind: 'chunk', parts: ['first'] });
  h.send({ jobId: 'a', kind: 'chunk', parts: ['second'] });
  h.send({ jobId: 'a', kind: 'done', finishReason: 'stop' });
  h.send({ jobId: 'b', kind: 'done', finishReason: 'stop' });
  await settle();
  assert.deepEqual(h.posts.filter((p) => p.body.jobId === 'a').map((p) => [p.path, p.body.parts?.[0]]), [ ['/ext/chunk', 'first'], ['/ext/chunk', 'second'], ['/ext/done', undefined] ]);
  assert.equal(h.posts[0].body.jobId, 'b');
  const retries = h.attempts.filter((m) => m.payload.jobId === 'a' && m.payload.parts?.[0] === 'first');
  assert.equal(retries.length, 3);
  assert.equal(new Set(retries.map((m) => m.deliveryId)).size, 1);
});

test('exhausted delivery aborts the job and drops queued chunks and completion', async () => {
  const h = setup((msg, _attempts, deliver) => {
    if (msg.payload.jobId === 'bad' && msg.payload.kind === 'chunk') throw Error('offline');
    return deliver();
  });
  h.send({ jobId: 'bad', kind: 'chunk', parts: ['lost'] });
  h.send({ jobId: 'bad', kind: 'chunk', parts: ['later'] });
  h.send({ jobId: 'bad', kind: 'done', finishReason: 'stop' });
  h.send({ jobId: 'good', kind: 'done', finishReason: 'stop' });
  await settle();
  assert.equal(h.attempts.filter((m) => m.payload.jobId === 'bad' && m.payload.kind === 'chunk').length, 6);
  assert.deepEqual(h.posts.filter((p) => p.body.jobId === 'bad').map((p) => p.path), ['/ext/error']);
  assert.equal(h.pageMessages.filter((m) => m.__aipass_bridge === 'abort' && m.jobId === 'bad').length, 1);
  assert.equal(h.posts.filter((p) => p.body.jobId === 'good').length, 1);
});

test('a disconnected worker cannot block other jobs or leak later events from the failed job', async () => {
  const h = setup((msg, _attempts, deliver) => {
    if (msg.payload.jobId === 'bad') throw Error('worker unavailable');
    return deliver();
  });
  h.send({ jobId: 'bad', kind: 'chunk', parts: ['lost'] });
  h.send({ jobId: 'good', kind: 'chunk', parts: ['ok'] });
  await settle();
  h.send({ jobId: 'bad', kind: 'done', finishReason: 'stop' });
  h.send({ jobId: 'good', kind: 'done', finishReason: 'stop' });
  await settle();
  assert.equal(h.pageMessages.filter((m) => m.__aipass_bridge === 'abort' && m.jobId === 'bad').length, 1);
  assert.deepEqual(h.posts.map((p) => [p.body.jobId, p.path]), [['good', '/ext/chunk'], ['good', '/ext/done']]);
  assert.equal(h.attempts.filter((m) => m.payload.jobId === 'bad').length, 12);
});
