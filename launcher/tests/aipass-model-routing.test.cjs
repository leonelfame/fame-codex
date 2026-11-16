const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
for (const selected of ['claude-opus-5-5@azure', 'auto']) {
  test(`upstream model switch respects requested selection ${selected}`, { timeout: 2000 }, async () => {
    let listener, body, resolve;
    const complete = new Promise(r => { resolve = r; });
    const replies = [];
    const window = { location: { origin: 'https://de.aipass.net' }, addEventListener(_name, fn) { listener = fn; },
      postMessage(msg) { replies.push(msg); if (['done', 'error'].includes(msg.kind)) resolve(msg); } };
    const event = { type: 'data-model_switched', data: { fromModelId: selected, toModelId: 'gemini-3.5-flash-lite', reason: 'credit_not_enough' } };
    const response = new Response(`data: ${JSON.stringify(event)}\n\ndata: ${JSON.stringify({ type: 'text-delta', delta: 'FALLBACK_TEXT' })}\n\ndata: {"type":"finish"}\n\n`);
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/aipass/extension/page.js'), 'utf8'), {
      window, AbortController, TextDecoder, URLSearchParams, crypto: require('node:crypto').webcrypto, setInterval, clearInterval,
      fetch: async (_url, options) => { body = JSON.parse(options.body); return response; },
    });
    listener({ source: window, data: { __aipass_bridge: 'req', job: { jobId: 'test', kind: 'chat', modelId: selected, text: 'probe', conversationId: 'owned-fixture' } } });
    const terminal = await complete;
    assert.equal(body.routing, selected === 'auto' ? 'auto' : 'manual');
    if (selected === 'auto') assert.equal(terminal.kind, 'done');
    else {
      assert.equal(terminal.kind, 'error');
      assert.match(terminal.message, /AIPASS_MODEL_MISMATCH.*credit_not_enough/);
      assert.equal(JSON.stringify(replies).includes('FALLBACK_TEXT'), false);
    }
  });
}
