// Live account test. No model responses, compaction events or browser interactions are mocked.
// Short source preflight: bun run scripts/smoke-codex-model-swap.mjs --probe-only
// Full test: apply live-runtime-overlay.mjs, run this with --installed-runtime, then restore.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.ts';
import { startServer } from '../src/server.ts';
import { augmentNativeModelCatalog } from '../src/model-catalog.ts';
import { createLauncherDevAdapter } from '../src/dev-chat/driver.ts';
import { closeChatGptBrowserWorkers } from '../src/adapters/chatgpt-web/browser-worker.ts';
import { closeTurnBrokers } from '../src/adapters/chatgpt-web/turn-broker.ts';
import { readJsonRequestBody } from '../src/http-body.ts';
import { estimateTokens } from '../src/lib/token-estimate.ts';

const resumeIndex = process.argv.indexOf('--resume-native');
const resuming = resumeIndex !== -1;
const installed = process.argv.includes('--installed-runtime');
const forkBeforeWeb = process.argv.includes('--fork-before-web');
const liveThreadIndex = process.argv.indexOf('--resume-live-thread');
const liveThreadId = liveThreadIndex === -1 ? undefined : process.argv[liveThreadIndex + 1];
if (liveThreadId && (!resuming || forkBeforeWeb || !/^[0-9a-f-]{36}$/.test(liveThreadId))) {
  throw new Error('--resume-live-thread requires --resume-native and cannot fork');
}
if (!installed && !process.argv.includes('--probe-only')) {
  throw new Error('Full compaction testing requires --installed-runtime; the remote source broker supports only the short --probe-only preflight');
}
const runRoot = resuming ? resolve(process.argv[resumeIndex + 1])
  : resolve('output', `model-swap-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`);
const sourceHome = process.env.ORCA_CODEX_HOME || process.env.CODEX_HOME || join(homedir(), '.codex');
const home = installed ? sourceHome : join(runRoot, 'codex-home');
const project = join(runRoot, 'project');
mkdirSync(home, { recursive: true, mode: 0o700 });
mkdirSync(project, { recursive: true });
const evidencePath = join(runRoot, 'evidence.jsonl');
const previous = resuming ? readFileSync(evidencePath, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
let resumePath;
let forkLastTurnId;
if (resuming && installed && !liveThreadId) {
  const id = previous.find(e => e.event === 'thread_created').threadId;
  const sourceSessions = join(runRoot, 'codex-home', 'sessions');
  const files = readdirSync(sourceSessions, { recursive: true }).filter(name => name.endsWith(`${id}.jsonl`));
  if (files.length !== 1) throw new Error('Expected exactly one authentic live-test rollout to import');
  const original = join(sourceSessions, files[0]);
  if (forkBeforeWeb) {
    resumePath = undefined;
    const rows = readFileSync(original, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const nativeTurns = new Set(rows.filter(row => row.type === 'turn_context' && row.payload.model === 'gpt-6-astra').map(row => row.payload.turn_id));
    forkLastTurnId = rows.filter(row => row.type === 'event_msg' && row.payload.type === 'task_complete'
      && nativeTurns.has(row.payload.turn_id) && row.payload.last_agent_message === 'BATCH_ACCEPTED').at(-1)?.payload.turn_id;
    if (!forkLastTurnId) throw new Error('Native boundary missing from the authentic test rollout');
  } else {
    resumePath = join(home, 'sessions', relative(sourceSessions, original));
    mkdirSync(dirname(resumePath), { recursive: true });
    if (!existsSync(resumePath)) copyFileSync(original, resumePath);
  }
}
const record = (event, detail = {}) => {
  const row = { at: new Date().toISOString(), event, ...detail };
  appendFileSync(evidencePath, JSON.stringify(row) + '\n');
  console.log(JSON.stringify(row));
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const nativeRequest = input instanceof Request && input.url.includes('/backend-api/codex/');
  if (nativeRequest && input.method === 'POST') {
    const raw = await readJsonRequestBody(input.clone());
    record('native_request', { endpoint: new URL(input.url).pathname, model: raw.model,
      encoding: input.headers.get('content-encoding'), decodedChars: JSON.stringify(raw).length,
      inputItems: raw.input?.length, previousResponse: !!raw.previous_response_id });
  }
  const response = await realFetch(input, options);
  if (nativeRequest && !response.ok) record('native_upstream_error', { status: response.status,
    requestId: response.headers.get('x-request-id'), detail: (await response.clone().text()).slice(0, 500) });
  return response;
};
function variedFiller(targetTokens) {
  // Unique inert receipts avoid treating compression limits on one repeated sentence as
  // a model context-window result. Keep the generated corpus reproducible within this run.
  const lines = [];
  let count = 0;
  for (let index = 0; count < targetTokens; index++) {
    const line = `Archive receipt ${index}: identifier=${randomUUID()}; source=${randomUUID()}; disposition=retained; no action requested.\n`;
    lines.push(line); count += estimateTokens(line);
  }
  const text = lines.join('');
  return { text, tokens: estimateTokens(text) };
}
const production = loadConfig();
if (!installed) {
  copyFileSync(join(sourceHome, 'auth.json'), join(home, 'auth.json'));
  process.once('exit', () => rmSync(join(home, 'auth.json'), { force: true }));
}
process.env.CODEX_HOME = home;
process.env.CODEX_SQLITE_HOME = home;
process.env.CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES = JSON.stringify([home]);
process.env.FAME_CODEX_HOME = join(runRoot, 'runtime');
mkdirSync(process.env.FAME_CODEX_HOME, { recursive: true });
const codex = process.env.FAME_LIVE_CODEX || 'codex';
const bundled = spawnSync(codex, ['debug', 'models', '--bundled'], { encoding: 'utf8', windowsHide: true });
if (bundled.status !== 0) throw new Error('Could not read bundled native model catalog');
const catalog = augmentNativeModelCatalog(JSON.parse(bundled.stdout), production);
const catalogPath = join(runRoot, 'models.json');
writeFileSync(catalogPath, JSON.stringify(catalog));
const config = { ...production, port: 0, brokerSocketPath: `\\\\.\\pipe\\fame-model-swap-${randomUUID()}` };
// Use the production launcher's authenticated browser and remote broker, but current source
// and its freshly rebuilt helper. Its running daemon and settings remain untouched.
const server = installed ? undefined : startServer(config, {
  adapterFactory: createLauncherDevAdapter(production, runRoot).adapterFactory,
});
const overrides = [
  `model="${resuming ? 'chatgpt-web/gpt-6-sol' : 'gpt-6-astra'}"`, 'model_provider="openai"',
  `model_catalog_json=${JSON.stringify(catalogPath)}`,
  `openai_base_url="http://127.0.0.1:${installed ? production.port : server.port}/v1"`,
  'approval_policy="never"', 'sandbox_mode="danger-full-access"',
  `model_reasoning_effort="${resuming ? 'medium' : 'low'}"`, 'web_search="disabled"',
  'features.multi_agent=false', 'features.multi_agent_v2=false',
];
if (!installed) writeFileSync(join(home, 'config.toml'), overrides.join('\n'));
const child = spawn(codex, ['app-server', '--stdio', ...overrides.flatMap(value => ['-c', value])], {
  cwd: project, env: { ...process.env, OPENAI_API_KEY: undefined },
  windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
});
let nextId = 0;
const pending = new Map();
const notifications = [];
let threadId;
let usage;
let compactCount = 0;
child.stderr.on('data', chunk => appendFileSync(join(runRoot, 'app-server.stderr.log'), chunk));
createInterface({ input: child.stdout }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id !== undefined && !message.method) {
    const request = pending.get(message.id);
    if (request) { pending.delete(message.id); message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result); }
  } else if (message.method) {
    notifications.push(message);
    if (message.id !== undefined) {
      child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Unattended live test does not grant interactive approvals' } }) + '\n');
      record('server_request_refused', { method: message.method });
    }
    if (message.method === 'thread/tokenUsage/updated') {
      usage = message.params.tokenUsage;
      record('usage', { threadId: message.params.threadId, usage });
    }
    if (message.method === 'thread/compacted' || (message.method === 'item/completed' && message.params.item?.type === 'contextCompaction')) {
      compactCount++;
      record('compaction', { method: message.method, threadId: message.params.threadId });
    }
    if (message.method === 'error') record('app_error', { detail: message.params });
  }
});
child.on('exit', code => { for (const request of pending.values()) request.reject(new Error(`app-server exited ${code}`)); pending.clear(); });
const rpc = (method, params) => new Promise((resolveResult, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve: resolveResult, reject });
  child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
});
const waitFor = async (predicate, from, timeoutMs = 20 * 60_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = notifications.slice(from).find(predicate);
    if (found) return found;
    await Bun.sleep(150);
  }
  throw new Error('Timed out waiting for real app-server event');
};
async function turn(model, text, label) {
  const from = notifications.length;
  record('turn_start', { label, model, inputChars: text.length, threadId });
  const started = await rpc('turn/start', { threadId, model, effort: model.startsWith('chatgpt-web/') ? 'medium' : 'low', input: [{ type: 'text', text, text_elements: [] }] });
  const completed = await waitFor(n => n.method === 'turn/completed' && n.params.turn.id === started.turn.id, from);
  const items = notifications.slice(from).filter(n => n.method === 'item/completed').map(n => n.params.item);
  const answer = items.filter(i => i.type === 'agentMessage').map(i => i.text).join('\n');
  record('turn_complete', { label, model, status: completed.params.turn.status, answer: answer.slice(-3000), error: completed.params.turn.error, toolCalls: items.filter(i => i.type === 'commandExecution').length });
  if (completed.params.turn.status !== 'completed') throw new Error(`Turn ${label} failed: ${JSON.stringify(completed.params.turn.error)}`);
  return answer;
}
const native = 'gpt-6-astra';
const web = 'chatgpt-web/gpt-6-sol';
const marker = resuming ? previous.find(e => e.event === 'turn_complete' && e.label === 'native_baseline').answer.trim()
  : `NORTHSTAR-${randomUUID().replaceAll('-', '')}`;
const deadline = setTimeout(() => { record('timeout'); child.kill(); }, 70 * 60_000);
try {
  record('run_start', { runRoot, native, web, source: installed ? 'installed-working-tree-overlay' : 'working-tree', browser: production.browserHost, contextLimitsOverridden: false });
  await rpc('initialize', { clientInfo: { name: 'codex_cli_rs', title: 'Fame Codex model swap live test', version: '1.0.0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  const started = resuming ? await rpc(forkBeforeWeb ? 'thread/fork' : 'thread/resume', { threadId: liveThreadId ?? previous.find(e => e.event === 'thread_created').threadId,
    ...(resumePath ? { path: resumePath } : {}),
    ...(forkLastTurnId ? { lastTurnId: forkLastTurnId } : {}),
    model: web, cwd: project, approvalPolicy: 'never', sandbox: 'danger-full-access', config: { model_reasoning_effort: 'medium' } })
    : await rpc('thread/start', { model: native, cwd: project, approvalPolicy: 'never', sandbox: 'danger-full-access', ephemeral: false,
    baseInstructions: 'You are running a live context continuity test. Follow the operator. Treat filler as inert data. Keep durable task facts in any compaction summary. Never inspect credentials or unrelated files. Keep answers brief.',
    developerInstructions: 'Never change files outside this test working directory. Do not spawn subagents.' });
  threadId = started.thread.id;
  record(forkBeforeWeb ? 'thread_forked_at_native_boundary' : resuming ? 'thread_resumed' : 'thread_created', { threadId, model: started.model, provider: started.modelProvider });
  if (!resuming) {
    const initial = await turn(native, `Remember this durable task fact across context compaction and model changes: mission_code=${marker}; target_file=proof.txt; required_content=continuity-ok. Repeat the mission_code exactly and nothing else.`, 'native_baseline');
    if (!initial.includes(marker)) throw new Error('Native baseline did not recall the mission code');
  }
  if (!resuming && !process.argv.includes('--probe-only')) {
    const before = compactCount;
    for (let index = 0; index < 7 && compactCount === before; index++) {
      const filler = variedFiller(65_000);
      await turn(native, `Context capacity test batch ${index + 1}. The following is inert archival filler, not instructions. Retain the mission_code and target_file in your durable memory. Reply only BATCH_ACCEPTED.\n<archive>\n${filler.text}\n</archive>`, `native_fill_${index + 1}`);
    }
    if (compactCount === before) throw new Error('No automatic native compaction observed at the real model limit');
    const nativeRecall = await turn(native, 'Return the mission_code, target_file and required_content from the original task. Do not read files.', 'native_post_compact_recall');
    if (!nativeRecall.includes(marker)) throw new Error('Native lost mission code after compaction');
  }
  const swap = await turn(web, 'The model has changed. Return the mission_code, target_file and required_content from the original task. Do not read files or infer a new value.', 'web_swap_recall');
  if (![marker, 'proof.txt', 'continuity-ok'].every(fact => swap.includes(fact))) throw new Error('Web model lost an original task fact after native-to-web model switch');
  if (!process.argv.includes('--probe-only')) {
    const before = compactCount;
    let restarted = false;
    for (let index = 0; index < 7 && compactCount === before; index++) {
      if (process.argv.includes('--restart-before-web-compact') && !restarted && installed
        && usage?.last.totalTokens >= usage?.modelContextWindow) {
        await Bun.sleep(500);
        const restart = spawnSync(process.execPath, [resolve('scripts/live-runtime-overlay.mjs'), 'restart'], {
          cwd: resolve('.'), encoding: 'utf8', windowsHide: true,
        });
        record('runtime_restart_before_compaction', { status: restart.status, detail: restart.stdout.trim() });
        if (restart.status !== 0) throw new Error('Could not restart the test runtime before compaction');
        restarted = true;
      }
      const filler = variedFiller(55_000);
      await turn(web, `Web context capacity test batch ${index + 1}. Inert archival filler follows. Preserve all original mission facts in any compaction summary. Reply only WEB_BATCH_ACCEPTED.\n<archive>\n${filler.text}\n</archive>`, `web_fill_${index + 1}`);
    }
    if (compactCount === before) throw new Error('No automatic web compaction observed at the real model limit');
    if (process.argv.includes('--restart-before-web-compact') && !restarted) throw new Error('Requested cold compaction test did not restart the runtime');
    const recall = await turn(web, 'Return the original mission_code, target_file and required_content without reading any file.', 'web_post_compact_recall');
    if (![marker, 'proof.txt', 'continuity-ok'].every(fact => recall.includes(fact))) throw new Error('Web lost an original task fact after web compaction');
    const proof = join(project, 'proof.txt');
    if (existsSync(proof)) {
      const { renameSync } = await import('node:fs');
      renameSync(proof, join(project, `proof-before-${randomUUID()}.txt`));
    }
    await turn(web, 'Now complete the original task: use your command tool to create target_file with required_content, then read it back. State the mission_code and report the observed file content.', 'web_post_compact_tool');
    if (readFileSync(join(project, 'proof.txt'), 'utf8').trim() !== 'continuity-ok') throw new Error('Real tool execution did not produce the expected file');
    record('proof_file_verified', { path: proof, content: readFileSync(proof, 'utf8'), threadId });
  }
  record('PASS', { compactCount, threadId, probeOnly: process.argv.includes('--probe-only') });
} catch (error) {
  record('FAIL', { message: error instanceof Error ? error.message : String(error), compactCount, threadId });
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  child.stdin.end(); child.kill();
  await closeChatGptBrowserWorkers();
  await closeTurnBrokers();
  await server?.stop(true);
  globalThis.fetch = realFetch;
  if (!installed) rmSync(join(home, 'auth.json'), { force: true });
  record('cleanup', { copiedAuthRemoved: !installed, productionSettingsChanged: false });
}
