// Temporary local runtime overlay for manual end-to-end testing; restores original bytes.
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
const root = join(homedir(), '.fame-codex');
const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
const installedApp = dirname(config.runtimeCommand[1]);
const backup = resolve(process.argv[3] || 'output/live-runtime-overlay');
const metadataFile = join(backup, 'overlay.json');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const health = async () => await (await fetch(`http://${config.host}:${config.port}/healthz`)).json();
const control = async name => {
  const response = await fetch(`http://${config.host}:${config.port}/admin/${name}`, {
    method: 'POST', headers: { authorization: `Bearer ${config.controlToken}` },
  });
  if (!response.ok) throw new Error(`${name} refused: HTTP ${response.status}`);
};
const before = await health();
if (before.active_http_turns || before.active_browser_turns) throw new Error('Runtime is busy; refusing overlay');
if (process.argv[2] === 'apply') {
  mkdirSync(backup, { recursive: true });
  if (existsSync(metadataFile)) {
    const saved = JSON.parse(readFileSync(metadataFile, 'utf8'));
    if (saved.installedApp !== installedApp) throw new Error('Backup belongs to another installed runtime');
    if (saved.files.every(file => hash(join(installedApp, file.name)) === file.overlayHash
      && hash(resolve('dist/runtime/app', file.name)) === file.overlayHash)) {
      console.log('The requested overlay is already active');
      process.exit(0);
    }
    if (!saved.files.every(file => hash(join(installedApp, file.name)) === file.originalHash)) {
      throw new Error('Restore the existing overlay before applying another build');
    }
  }
  const files = ['cli.js', 'browser-helper.cjs'].map(name => {
    const original = join(installedApp, name);
    const source = resolve('dist/runtime/app', name);
    copyFileSync(original, join(backup, name));
    return { name, originalHash: hash(original), overlayHash: hash(source) };
  });
  writeFileSync(metadataFile, JSON.stringify({ installedApp, files }, null, 2));
  for (const file of files) copyFileSync(resolve('dist/runtime/app', file.name), join(installedApp, file.name));
} else if (process.argv[2] === 'restore') {
  const saved = JSON.parse(readFileSync(metadataFile, 'utf8'));
  if (saved.installedApp !== installedApp) throw new Error('Installed runtime changed since overlay');
  if (saved.files.every(file => hash(join(installedApp, file.name)) === file.originalHash)) {
    console.log('Original runtime is already restored');
    process.exit(0);
  }
  for (const file of saved.files) {
    if (hash(join(installedApp, file.name)) !== file.overlayHash) throw new Error(`Overlay was changed: ${file.name}`);
    if (hash(join(backup, file.name)) !== file.originalHash) throw new Error(`Backup integrity failed: ${file.name}`);
  }
  for (const file of saved.files) copyFileSync(join(backup, file.name), join(installedApp, file.name));
} else if (process.argv[2] !== 'restart') throw new Error('Expected apply, restore, or restart');
await control('drain');
await control('shutdown');
let restarted = false;
for (let attempt = 0; attempt < 120; attempt++) {
  await Bun.sleep(250);
  try {
    const after = await health();
    if (after.pid !== before.pid && after.status === 'ok') {
      console.log(JSON.stringify({ action: process.argv[2], beforePid: before.pid, afterPid: after.pid, backup }));
      restarted = true; break;
    }
  } catch { /* Wait for the launcher's normal supervisor restart. */ }
}
if (!restarted) throw new Error('Launcher did not restart its runtime within 30 seconds');
