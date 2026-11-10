#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { stringify } from 'yaml';
import { createCanvas } from '@napi-rs/canvas';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = path.join(projectRoot, 'node_modules', '@deepseek-ai', 'dsh');
const metadata = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
if (metadata.version !== '0.2.2-rc.1') throw new Error(`Expected exact DSH 0.2.2-rc.1, found ${metadata.version}`);
const cliBin = path.resolve(packageDir, typeof metadata.bin === 'string' ? metadata.bin : metadata.bin.dsh);
const base = path.join(projectRoot, 'test-output', `harness-smoke-${Date.now()}-${randomUUID().slice(0, 8)}`);
const sourceDir = path.join(base, 'synthetic-sources');
const home = path.join(base, 'isolated-dsh-home');
const dataDir = path.join(base, 'audit-data');
await mkdir(sourceDir, { recursive: true }); await mkdir(home, { recursive: true });
await writeFile(path.join(sourceDir, 'main.txt'), 'Compound 3a; experiment=exp-smoke; batch=batch-smoke; 92% isolated yield; 98% ee.\n', 'utf8');
await writeFile(path.join(sourceDir, 'si.txt'), 'Compound 3a; experiment=exp-smoke; batch=batch-smoke; 80% isolated yield; er 98:2.\n¹H NMR (400 MHz, CDCl3) δ 7.12 (s, 1H).\nHRMS calcd for neutral formula C2H6O [M+H]+ 47.0491; Found 47.0492.\n', 'utf8');

// Controlled raster fixture: actual local OCR must reconstruct all six columns.
// The probe's acceptance is a scripted test transition, not approval of real user data.
const expectedTable = [
  ['Entry', 'Product', 'Yield', 'ee', 'Time', 'Temp'],
  ['1', '3a', '92', '98', '2', '25'],
  ['2', '3b', '80', '96', '4', '40'],
  ['3', '3c', '70', '94', '6', '60'],
];
const canvas = createCanvas(1600, 500), context = canvas.getContext('2d');
context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height);
context.fillStyle = 'black'; context.strokeStyle = 'black'; context.lineWidth = 3;
const xs = [20, 280, 540, 800, 1060, 1320, 1580], ys = [20, 135, 250, 365, 480];
for (const x of xs) { context.beginPath(); context.moveTo(x, ys[0]); context.lineTo(x, ys.at(-1)); context.stroke(); }
for (const y of ys) { context.beginPath(); context.moveTo(xs[0], y); context.lineTo(xs.at(-1), y); context.stroke(); }
context.font = '38px Arial';
expectedTable.forEach((row, y) => row.forEach((text, x) => context.fillText(text, xs[x] + 30, ys[y] + 70)));
await writeFile(path.join(sourceDir, 'table.png'), canvas.toBuffer('image/png'));
const spectrumCanvas = createCanvas(1500, 400), spectrumContext = spectrumCanvas.getContext('2d');
spectrumContext.fillStyle = 'white'; spectrumContext.fillRect(0, 0, 1500, 400); spectrumContext.fillStyle = 'black'; spectrumContext.font = '60px Arial';
spectrumContext.fillText('Compound 3a', 40, 85); spectrumContext.fillText('1H NMR 400 MHz CDCl3', 40, 190); spectrumContext.fillText('Integral sum: 2 H', 40, 300);
await writeFile(path.join(sourceDir, 'spectrum.png'), spectrumCanvas.toBuffer('image/png'));
await writeFile(path.join(sourceDir, 'expected-table.json'), JSON.stringify(expectedTable));

const removedData = path.join(base, 'removed-serve-must-not-create');
const removedServe = spawnSync(process.execPath, [path.join(projectRoot, 'src', 'cli.js'), 'serve', '--data', removedData], { cwd: sourceDir, encoding: 'utf8', windowsHide: true, timeout: 10000 });
const removedDataExists = await stat(removedData).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
if (removedServe.status !== 1 || !/移除/.test(removedServe.stderr) || removedDataExists) throw new Error('Removed serve entrypoint did not reject safely before creating state');

const profileDir=path.join(home,'profiles','sdk-minimal');await mkdir(profileDir,{recursive:true});
await writeFile(path.join(profileDir,'package.json'),JSON.stringify({name:'dsh-profile-sdk-minimal',private:true,dependencies:{},dsh:{profile:{bundles:['@deepseek-ai/dsh-sdk-minimal']}}}));
const overlay = path.join(profileDir, 'cordis.patch.yml');
await writeFile(overlay, stringify([
  { id: 'session-log-deepseek', disabled: true },
  { id: 'plugin-package-inventory-deepseek', disabled: true },
  { id: 'llm-deepseek', disabled: true },
  { insert: [
    { id:'config-editor',name:'@deepseek-ai/dsh-config-editor' },
    { id:'settings',name:'@deepseek-ai/dsh-settings' },
    { id: 'paper-si-audit', name: pathToFileURL(process.env.PAPER_AUDIT_PLUGIN_ENTRY || path.join(projectRoot, 'src', 'plugin.js')).href, config: { dataDir, allowedRoots: [sourceDir] } },
    { id: 'paper-audit-smoke-probe', name: pathToFileURL(path.join(projectRoot, 'scripts', 'harness-probe.js')).href, config: { sourceDir } },
  ] },
]), 'utf8');

const env = { ...process.env };
// Do not inherit a user's Harness settings or provider credentials into this fixture.
for (const key of Object.keys(env)) if (/^DSH_/i.test(key) || /(?:API_KEY|TOKEN|SECRET|PASSWORD)/i.test(key)) delete env[key];
env.DSH_HOME = home;
const version = spawnSync(process.execPath, [cliBin, '--version'], { cwd: sourceDir, env, encoding: 'utf8', windowsHide: true });
if (version.status !== 0 || version.stdout.trim() !== '0.2.2-rc.1') throw new Error('Installed target CLI version check failed');

const child = spawn(process.execPath, [cliBin, '--profile', 'sdk-minimal'], {
  cwd: sourceDir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
});
let stdout = '', stderr = '', pending = '', result = null, timedOut = false, shutdownAcknowledged = false;
const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 90000);
child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
child.stdout.on('data', text => {
  stdout += text; pending += text;
  if (stdout.length > 2 * 1024 * 1024) { child.kill(); return; }
  let end;
  while ((end = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, end); pending = pending.slice(end + 1);
    let frame; try { frame = JSON.parse(line); } catch { continue; }
    if (frame.method === 'paper-audit.smoke' && !result) {
      result = frame.params;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'paper-smoke-shutdown', method: 'shutdown', params: {} }) + '\n');
    }
    if (frame.id === 'paper-smoke-shutdown' && !frame.error) shutdownAcknowledged = true;
  }
});
child.stderr.on('data', text => { stderr += text; if (stderr.length > 2 * 1024 * 1024) child.kill(); });
let spawnError;
child.on('error', error => { spawnError = error; });
const close = await new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
clearTimeout(timeout);
const passed = close.code === 0 && result?.passed === true && shutdownAcknowledged && !timedOut && !spawnError;
const record = {
  passed, hostVersion: metadata.version, upstreamCommit: '66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db',
  checkedAt: new Date().toISOString(), isolatedHome: home, dataDir,
  networkPluginsDisabled: ['session-log-deepseek', 'plugin-package-inventory-deepseek', 'llm-deepseek'],
  serveEntrypointRemoved: true,
  ...result, shutdownAcknowledged, exitCode: close.code, signal: close.signal, timedOut,
  spawnError: spawnError?.message ?? null,
};
// Do not permit a probe's passed flag to overwrite the overall shutdown/exit check.
record.passed = passed;
await writeFile(path.join(base, 'result.json'), JSON.stringify(record, null, 2), 'utf8');
await writeFile(path.join(base, 'stdout.jsonl'), stdout, 'utf8');
await writeFile(path.join(base, 'stderr.log'), stderr, 'utf8');
console.log(JSON.stringify({ ...record, resultPath: path.join(base, 'result.json') }, null, 2));
if (!passed) {
  console.error(stderr.slice(-10000));
  process.exitCode = 1;
}
