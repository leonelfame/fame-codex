// ISOLATED world. Two jobs: relay between page.js and the service worker, and
// keep that worker alive.
(() => {
const GEN = (window.__aipassBridgeContentGen ?? 0) + 1;
window.__aipassBridgeContentGen = GEN;
const current = () => window.__aipassBridgeContentGen === GEN;

const TAG = '__aipass_bridge';

const jobs = new Map();

async function toWorker(payload) {
  const deliveryId = crypto.randomUUID();
  for (let attempt = 0; attempt <= 5; attempt++) {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'from-page', payload, deliveryId });
      if (response?.accepted) return true;
    } catch { /* retry the same delivery */ }
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
  }
  return false;
}

window.addEventListener('message', (event) => {
  if (!current()) return;
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || typeof msg !== 'object' || msg[TAG] !== 'res') return;
  const { [TAG]: _, ...payload } = msg;
  if (!payload.jobId) return;
  let state = jobs.get(payload.jobId);
  if (!state) {
    state = { tail: Promise.resolve(), failed: false };
    jobs.set(payload.jobId, state);
  }
  const terminal = ['done', 'error', 'loader', 'assistant'].includes(payload.kind);
  state.tail = state.tail.then(async () => {
    if (state.failed) return;
    if (!await toWorker(payload)) {
      state.failed = true;
      window.postMessage({ [TAG]: 'abort', jobId: payload.jobId }, window.location.origin);
      await toWorker({ jobId: payload.jobId, kind: 'error', message: 'extension could not deliver the job response' });
      setTimeout(() => { if (jobs.get(payload.jobId) === state) jobs.delete(payload.jobId); }, 60_000);
    } else if (terminal && jobs.get(payload.jobId) === state) {
      jobs.delete(payload.jobId);
    }
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!current()) return;
  if (msg?.type === 'run') window.postMessage({ [TAG]: 'req', job: msg.job }, window.location.origin);
  else if (msg?.type === 'abort') window.postMessage({ [TAG]: 'abort', jobId: msg.jobId }, window.location.origin);
  else if (msg?.type === 'ping') { sendResponse({ ok: true }); return true; }
});

// Chrome evicts an idle MV3 worker after ~30s, and inbound SSE data does not
// count as activity — without this the bridge sees a disconnect/reconnect
// cycle every half minute, and any job landing in that window fails. An open
// port does count, so hold one and cycle it before Chrome's 5-minute ceiling.
function keepAlive() {
  let port;
  try { port = chrome.runtime.connect({ name: 'keepalive' }); }
  catch { setTimeout(keepAlive, 1000); return; }

  const beat = setInterval(() => {
    try { port.postMessage({ t: Date.now() }); } catch { /* disconnect handles it */ }
  }, 20_000);
  const cycle = setTimeout(() => port.disconnect(), 4 * 60 * 1000);

  port.onDisconnect.addListener(() => {
    clearInterval(beat);
    clearTimeout(cycle);
    setTimeout(keepAlive, 250);
  });
}
keepAlive();
})();
