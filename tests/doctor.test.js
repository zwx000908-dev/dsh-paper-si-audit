import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnoseHarness } from '../scripts/doctor-harness.js';

const root = fileURLToPath(new URL('../test-output/', import.meta.url));
async function fixture(t, { enabled = false, roots = [], override = '', hostVersion = '0.2.2-rc.1' } = {}) {
  await mkdir(root, { recursive: true });
  const home = await mkdtemp(path.join(root, 'doctor-'));
  const profile = path.join(home, 'profiles/desktop');
  const pkg = path.join(profile, 'node_modules/dsh-paper-si-audit');
  await mkdir(pkg, { recursive: true });
  const metadata = { name: 'private-profile-name', credentials: { secret: 'DO_NOT_PRINT_ME' }, dependencies: { 'dsh-paper-si-audit': 'file:test.tgz' }, dsh: { profile: { bundles: enabled ? ['dsh-paper-si-audit'] : [] } } };
  const manifest = JSON.stringify(metadata);
  await writeFile(path.join(profile, 'package.json'), manifest);
  await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: 'dsh-paper-si-audit', version: '0.1.0', engines: { dsh: hostVersion }, dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  await writeFile(path.join(pkg, 'cordis.patch.yml'), '- insert:\n    - id: paper-si-audit\n      name: dsh-paper-si-audit\n      config:\n        allowedRoots: []\n');
  await writeFile(path.join(profile, 'cordis.patch.yml'), override || '[]\n');
  t.after(async () => { assert.ok(path.relative(root, home).startsWith('doctor-')); await rm(home, { recursive: true, force: true }); });
  return { home, profile, manifest, options: { home, profile: 'desktop', hostVersion }, roots };
}

test('doctor separates installed package, selected bundle and absent session registration without writes or credential output', async t => {
  const f = await fixture(t);
  const result = await diagnoseHarness(f.options);
  assert.equal(result.package.installed, true); assert.equal(result.package.selectedInProfileBundles, false);
  assert.equal(result.configuration.rootsState, 'empty'); assert.equal(result.nativeTools.state, 'not_observed_in_this_session');
  assert.ok(result.checks.some(c => c.code === 'BUNDLE_NOT_SELECTED'));
  assert.ok(result.checks.some(c => c.code === 'ALLOWED_ROOTS_EMPTY'));
  assert.equal(result.runtime.source, 'user_supplied_not_runtime_verified');
  assert.equal(JSON.stringify(result).includes('DO_NOT_PRINT_ME'), false);
  assert.deepEqual(result.changedFiles, []); assert.equal(await readFile(path.join(f.profile, 'package.json'), 'utf8'), f.manifest);
});

test('doctor detects enabled bundle with configured roots but still does not claim current-session tools exist', async t => {
  const f = await fixture(t, { enabled: true });
  const source = path.join(f.home, 'papers'); await mkdir(source);
  await writeFile(path.join(f.profile, 'cordis.patch.yml'), `- id: paper-si-audit\n  config:\n    dataDir: ${JSON.stringify(path.join(f.home, 'data'))}\n    allowedRoots:\n      - ${JSON.stringify(source)}\n`);
  const result = await diagnoseHarness(f.options);
  assert.equal(result.package.selectedInProfileBundles, true); assert.equal(result.configuration.visibleRowSelected, true);
  assert.equal(result.configuration.allowedRoots[0].existsAsDirectory, true);
  assert.ok(!result.checks.some(c => c.code === 'BUNDLE_NOT_SELECTED' || c.code === 'ALLOWED_ROOTS_EMPTY'));
  assert.equal(result.nativeTools.state, 'not_observed_in_this_session');
});

test('doctor rejects profile traversal and distinguishes wrong runtime, disabled row, and incomplete unsafe YAML', async t => {
  const f = await fixture(t, { enabled: true, hostVersion: '0.2.1-rc.2', override: '- id: paper-si-audit\n  disabled: true\n  config: !!js "process.env.SECRET"\n' });
  await assert.rejects(diagnoseHarness({ ...f.options, profile: '../desktop' }), /Invalid profile/);
  const result = await diagnoseHarness(f.options);
  assert.ok(result.checks.some(c => c.code === 'RUNTIME_VERSION_MISMATCH'));
  assert.ok(result.checks.some(c => c.code === 'STATIC_CONFIGURATION_INCOMPLETE'));
  assert.equal(JSON.stringify(result).includes('process.env.SECRET'), false);
});

test('doctor patch previews are explicit only and preserve absent profile state', async t => {
  const f = await fixture(t);
  const result = await diagnoseHarness({ ...f.options, sourceRoot: f.home, dataDir: path.join(f.home, 'new-data') });
  assert.match(result.suggestions.profileOverridePreview, /allowedRoots:/);
  assert.match(result.suggestions.profileOverridePreview, /dataDir:/);
  assert.deepEqual(result.changedFiles, []);
  const missing = await diagnoseHarness({ home: path.join(f.home, 'nonexistent'), profile: 'desktop', hostVersion: '0.2.2-rc.1' });
  assert.ok(missing.checks.some(c => c.code === 'PROFILE_NOT_FOUND'));
  assert.equal(missing.package.installed, false);
});

test('doctor reports disabled plain rows, direct inserts and safe complete-config previews separately', async t => {
  const f = await fixture(t, { enabled: true, override: '- id: paper-si-audit\n  disabled: true\n' });
  const disabled = await diagnoseHarness(f.options);
  assert.ok(disabled.checks.some(c => c.code === 'PLUGIN_ROW_DISABLED'));
  await writeFile(path.join(f.profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-paper-si-audit': 'file:test.tgz' }, dsh: { profile: { bundles: [] } } }));
  await writeFile(path.join(f.profile, 'cordis.patch.yml'), '- insert:\n    - id: paper-si-audit\n      name: dsh-paper-si-audit\n      config:\n        allowedRoots: []\n');
  const direct = await diagnoseHarness({ ...f.options, sourceRoot: f.home });
  assert.equal(direct.configuration.visibleRowSelected, true);
  assert.equal(direct.checks.find(c => c.code === 'BUNDLE_NOT_SELECTED').level, 'warning');
  assert.equal(direct.suggestions.profileOverridePreview, null);
  assert.match(direct.suggestions.previewNote, /both/);
});
