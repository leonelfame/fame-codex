import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const serverPath = new URL('../assets/aipass/bridge/server.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');

function turboRecord(value) {
  const flat = [];
  function encode(entry) {
    const index = flat.length;
    flat.push(null);
    flat[index] = Array.isArray(entry) ? entry.map(encode)
      : entry && typeof entry === 'object'
        ? Object.fromEntries(Object.entries(entry).map(([key, item]) => [`_${encode(key)}`, encode(item)]))
        : entry;
    return index;
  }
  encode(value);
  return JSON.stringify(flat);
}

async function fixture(t, env = {}, models = null) {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [serverPath], { env: { ...process.env, AIPASS_PORT: String(port), ...env }, stdio: 'ignore' });
  t.after(() => child.kill());
  for (let i = 0; ; i++) {
    try { await fetch(base + '/health'); break; } catch (e) { if (i === 100) throw e; await delay(20); }
  }
  const post = (path, body, options = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...options });
  const eventAbort = new AbortController();
  t.after(() => eventAbort.abort());
  const response = await fetch(base + '/ext/events', { signal: eventAbort.signal });
  const reader = response.body.getReader();
  const queue = [];
  const waiters = [];
  const aborts = [];
  (async () => {
    let buffer = '';
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const record = buffer.slice(0, index); buffer = buffer.slice(index + 2);
          if (record.startsWith('event: abort\n')) { aborts.push(JSON.parse(record.split('\ndata: ')[1])); continue; }
          if (!record.startsWith('event: job\n')) continue;
          const job = JSON.parse(record.split('\ndata: ')[1]);
          if (job.kind === 'loader') {
            if (models === 'error' && String(job.url).startsWith('/loaders/list-models.data')) {
              void post('/ext/error', { jobId: job.jobId, message: 'fixture model loader unavailable' });
              continue;
            }
            const raw = models && String(job.url).startsWith('/loaders/list-models.data')
              ? turboRecord({ models }) : '[]';
            void post('/ext/loader', { jobId: job.jobId, raw });
            continue;
          }
          if (waiters.length) waiters.shift()(job); else queue.push(job);
        }
      }
    } catch {}
  })();
  const next = () => queue.length ? Promise.resolve(queue.shift()) : Promise.race([new Promise(resolve => waiters.push(resolve)), delay(3000).then(() => { throw Error('extension job timed out'); })]);
  const created = (job, id) => post('/ext/loader', { jobId: job.jobId, raw: JSON.stringify([{ _1: 2 }, 'id', id]) });
  return { base, post, next, created, child, aborts };
}

const chatBody = { model: 'gemini-3.1-flash-lite', stream: true, messages: [{ role: 'user', content: 'hello' }] };

test('model loader carries per-model thinking levels and excludes non-chat categories when configured', async t => {
  const f = await fixture(t, { AIPASS_MODEL_FILTER: 'chat' }, [
    { id: 'opus-example', displayName: 'Opus', thinkingConfig: { supportedLevels: ['low', 'medium', 'high', 'max'] } },
    { id: 'gemini-example', displayName: 'Gemini' },
    { id: 'seedream-4.0', displayName: 'Image' },
  ]);
  const response = await fetch(f.base + '/v1/models?refresh=1');
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.deepEqual(data.map(row => ({ id: row.id, thinking: row.thinking })), [
    { id: 'opus-example', thinking: ['low', 'medium', 'high', 'max'] },
    { id: 'gemini-example', thinking: null },
  ]);
});

test('explicit model refresh reports upstream loader failure instead of an apparently fresh catalog', async t => {
  const f = await fixture(t, { AIPASS_MODEL_FILTER: 'chat' }, 'error');
  const response = await fetch(f.base + '/v1/models?refresh=1');
  assert.equal(response.status, 500);
  assert.match(await response.text(), /model loader failed/);
});

test('explicit model refresh rejects an empty upstream catalog instead of publishing fallback models', async t => {
  const f = await fixture(t, { AIPASS_MODEL_FILTER: 'chat' }, []);
  const response = await fetch(f.base + '/v1/models?refresh=1');
  assert.equal(response.status, 500);
  assert.match(await response.text(), /model loader failed/);
});

test('temporary conversations are consumed once, failures do not retry, and contention is rejected', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('/conversations/new', { temporary: false })).status, 400);
  const create = f.post('/conversations/new', { temporary: true });
  const first = await f.next();
  assert.equal(first.kind, 'create'); assert.equal(first.temporary, true);
  assert.equal((await f.post('/conversations/new', { temporary: true })).status, 409);
  assert.equal((await f.post('/config', { conversation: 'history', temporary: true })).status, 409);
  await f.created(first, 'fresh-1');
  assert.deepEqual(await (await create).json(), { id: 'fresh-1', temporary: true });
  assert.equal((await f.post('/config', { conversation: 'history', temporary: true })).status, 409);
  const chat = f.post('/v1/chat/completions', chatBody);
  const job = await f.next();
  assert.equal(job.kind, 'chat'); assert.equal(job.conversationId, 'fresh-1'); assert.equal(job.temporary, true);
  assert.equal((await f.post('/v1/chat/completions', chatBody)).status, 409);
  assert.equal((await f.post('/conversations/new', { temporary: true })).status, 409);
  await f.post('/ext/error', { jobId: job.jobId, message: 'returned 404' });
  assert.match(await (await chat).text(), /upstream_error/);
  assert.equal((await f.post('/v1/chat/completions', chatBody)).status, 409);
  assert.equal((await f.post('/config', { conversation: 'history', temporary: true })).status, 400);
  const create2 = f.post('/conversations/new', { temporary: true });
  const second = await f.next(); assert.equal(second.kind, 'create');
  await f.created(second, 'fresh-2'); await create2;
  const chat2 = f.post('/v1/chat/completions', chatBody);
  const job2 = await f.next(); assert.equal(job2.conversationId, 'fresh-2');
  await f.post('/ext/chunk', { jobId: job2.jobId, parts: [{ kind: 'text', text: 'answer' }] });
  await f.post('/ext/done', { jobId: job2.jobId, finishReason: 'stop' });
  const stream = await (await chat2).text(); assert.match(stream, /answer/); assert.match(stream, /\[DONE\]/);
  assert.equal((await (await f.post('/ext/done', { jobId: job.jobId })).json()).ok, false);
});

test('disconnected creation cannot overwrite a later conversation', async t => {
  const f = await fixture(t);
  const abort = new AbortController();
  const stale = f.post('/conversations/new', { temporary: true }, { signal: abort.signal }).catch(() => null);
  const oldJob = await f.next(); abort.abort(); await stale;
  let fresh;
  for (let i = 0; i < 50; i++) {
    const pending = f.post('/conversations/new', { temporary: true });
    const result = await Promise.race([pending.then(r => ({ response: r })), delay(20).then(() => ({}))]);
    if (!result.response) { fresh = pending; break; }
    assert.equal(result.response.status, 409); await delay(10);
  }
  assert.ok(fresh);
  const newJob = await f.next();
  await f.created(newJob, 'new-id'); await fresh;
  await f.created(oldJob, 'stale-id');
  const health = await (await fetch(f.base + '/health')).json();
  assert.equal(health.conversation, 'new-id');
  const chat = f.post('/v1/chat/completions', chatBody);
  const job = await f.next(); assert.equal(job.conversationId, 'new-id');
  await f.post('/ext/done', { jobId: job.jobId }); await (await chat).text();
});

test('pinned conversation cannot be used', async t => {
  const f = await fixture(t, { AIPASS_CONVERSATION_ID: 'old-history' });
  assert.equal((await f.post('/conversations/new', { temporary: true })).status, 409);
  assert.equal((await f.post('/v1/chat/completions', chatBody)).status, 409);
});

test('isolated requests bind their own temporary IDs under contention and configuration changes', async t => {
  const f = await fixture(t, { AIPASS_CONVERSATION_ID: 'pinned-history' });
  const health = await (await fetch(f.base + '/health')).json();
  assert.equal(health.capabilities.isolatedTurns, true);
  assert.equal(health.capabilities.freshConversationOnly, false);
  assert.equal((await f.post('/config', { assistant: 'before', aspectRatio: '1:1' })).status, 200);
  const a = f.post('/v1/chat/isolated', { ...chatBody, messages: [{ role: 'user', content: 'alpha' }] });
  const b = f.post('/v1/chat/isolated', { ...chatBody, messages: [{ role: 'user', content: 'beta' }] });
  const first = await f.next(), second = await f.next();
  assert.equal(first.temporary, true); assert.equal(second.temporary, true);
  assert.equal(first.assistant, 'before'); assert.equal(second.assistant, 'before');
  assert.equal((await f.post('/config', { conversation: 'history', temporary: true })).status, 400);
  assert.equal((await f.post('/config', { assistant: 'after', aspectRatio: '3:4' })).status, 200);
  await f.created(second, 'second-id');
  const secondChat = await f.next();
  await f.created(first, 'first-id');
  const firstChat = await f.next();
  assert.equal(secondChat.conversationId, 'second-id');
  assert.equal(firstChat.conversationId, 'first-id');
  assert.equal(firstChat.temporary, true); assert.equal(secondChat.temporary, true);
  assert.equal(firstChat.aspectRatio, '1:1'); assert.equal(secondChat.aspectRatio, '1:1');
  assert.deepEqual(new Set([firstChat.text, secondChat.text]), new Set(['alpha', 'beta']));
  await f.post('/ext/chunk', { jobId: firstChat.jobId, parts: [{ kind: 'text', text: firstChat.text }] });
  await f.post('/ext/done', { jobId: firstChat.jobId });
  await f.post('/ext/chunk', { jobId: secondChat.jobId, parts: [{ kind: 'text', text: secondChat.text }] });
  await f.post('/ext/done', { jobId: secondChat.jobId });
  assert.match(await (await a).text(), /alpha/);
  assert.match(await (await b).text(), /beta/);
});

test('isolated cancellation rejects stale extension replies and does not dispatch chat', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const pending = f.post('/v1/chat/isolated', chatBody, { signal: controller.signal }).catch(() => null);
  const create = await f.next();
  controller.abort(); await pending;
  await delay(50);
  const late = await (await f.created(create, 'stale-id')).json();
  assert.equal(late.ok, false);
  const next = f.post('/v1/chat/isolated', chatBody);
  const nextCreate = await f.next(); assert.equal(nextCreate.kind, 'create');
  await f.created(nextCreate, 'fresh-id');
  const job = await f.next(); assert.equal(job.kind, 'chat'); assert.equal(job.conversationId, 'fresh-id');
  await f.post('/ext/error', { jobId: job.jobId, message: 'returned 409' });
  assert.match(await (await next).text(), /upstream_error/);
});

test('isolated streaming cancellation aborts its chat while another request completes', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const pending = f.post('/v1/chat/isolated', chatBody, { signal: controller.signal });
  const create = await f.next(); await f.created(create, 'cancel-chat');
  const chat = await f.next();
  const response = await pending;
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  controller.abort();
  for (let i = 0; i < 100 && !f.aborts.some(item => item.jobId === chat.jobId); i++) await delay(10);
  assert.ok(f.aborts.some(item => item.jobId === chat.jobId));
  assert.equal((await (await f.post('/ext/done', { jobId: chat.jobId })).json()).ok, false);
  const other = f.post('/v1/chat/isolated', { ...chatBody, stream: false });
  const otherCreate = await f.next(); await f.created(otherCreate, 'other-chat');
  const otherChat = await f.next();
  await f.post('/ext/chunk', { jobId: otherChat.jobId, parts: [{ kind: 'text', text: 'survived' }] });
  await f.post('/ext/done', { jobId: otherChat.jobId });
  assert.equal((await (await other).json()).choices[0].message.content, 'survived');
});

test('isolated requests reject unsupported video and repeated upstream IDs', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('/v1/chat/isolated', { ...chatBody, model: 'veo-3' })).status, 400);
  const first = f.post('/v1/chat/isolated', chatBody);
  await f.created(await f.next(), 'duplicate');
  const job = await f.next(); await f.post('/ext/done', { jobId: job.jobId }); await (await first).text();
  const second = f.post('/v1/chat/isolated', chatBody);
  await f.created(await f.next(), 'duplicate');
  assert.equal((await second).status, 502);
});
