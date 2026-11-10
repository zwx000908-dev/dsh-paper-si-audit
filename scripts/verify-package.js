import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import assert from 'node:assert/strict';
import tar from 'tar-stream';
const root = fileURLToPath(new URL('../', import.meta.url));
const sourceManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const archive = path.join(root, `dist/dsh-paper-si-audit-${sourceManifest.version}.tgz`);
const archiveBytes = await readFile(archive);
// Parse the UTF-8 tar names in Node; system tar on an English Windows runner
// can reject valid non-ASCII filenames using its local codepage.
const contents = new Map();
const extractor = tar.extract();
extractor.on('entry', (header, stream, next) => {
  const chunks = [];
  if (header.type !== 'file' || contents.has(header.name)) { stream.resume(); extractor.destroy(new Error('Unsupported or duplicate archive entry')); return; }
  stream.on('data', chunk => chunks.push(chunk));
  stream.on('end', () => { contents.set(header.name, Buffer.concat(chunks)); next(); });
  stream.on('error', error => extractor.destroy(error));
});
await new Promise((resolve, reject) => { extractor.once('finish', resolve); extractor.once('error', reject); extractor.end(gunzipSync(archiveBytes, { maxOutputLength: 8 * 1024 * 1024 })); });
const members = [...contents.keys()];
for (const member of members) {
  assert.ok(member.startsWith('package/') && !/[\\:\0]/.test(member) && member.split('/').every(part => part !== '' && part !== '.' && part !== '..'), `Unsafe archive path: ${member}`);
  assert.ok(!/(?:node_modules|\.audit-data|test-output|\.npm-cache|\/outputs\/|\/paper\/|\/\.env(?:\.|$))/.test(member));
}
assert.ok(members.length >= 20);
const manifest = JSON.parse(contents.get('package/package.json').toString('utf8'));
assert.equal(manifest.name, 'dsh-paper-si-audit');
assert.equal(manifest.version, sourceManifest.version);
assert.equal(manifest.engines.dsh, '0.2.2-rc.1');
assert.equal(manifest.engines.node, '>=24.9.0');
assert.ok(manifest.keywords.includes('dsh-plugin'));
assert.equal(manifest.repository.url, 'git+https://github.com/zwx000908-dev/dsh-paper-si-audit.git');
for (const member of [manifest.main, manifest.dsh.bundle.patch, ...Object.values(manifest.bin), 'src/settings.js', 'src/settings-schema.js', 'docs/SETTINGS.md', 'src/service.js', 'src/engine.js', 'src/profiles.js', 'src/parsers.js', 'src/report.js', 'src/stoichiometry.js', 'src/version.js', 'src/hrms.js', 'src/isotope-masses.json', 'src/image-tables.js', 'scripts/doctor-harness.js', 'profiles/custom-demo.yaml', 'docs/VALIDATION.md', 'docs/HRMS.md', 'docs/IMAGE-TABLES.md']) assert.ok(members.includes('package/' + member.replace(/^\.\//, '')), `Missing ${member}`);
assert.ok(!members.some(m => m.startsWith('package/web/') || m === 'package/src/server.js'), 'Removed web panel/server must not be packaged');
assert.ok(!manifest.scripts?.start, 'Removed web launch script must not be packaged');
for (const member of ['CHANGELOG.md', 'icon.svg', 'locale/en.json', 'locale/zh.json']) assert.ok(members.includes('package/' + member), `Missing ${member}`);
await mkdir(path.join(root, 'test-output'), { recursive: true });
const unpacked = await mkdtemp(path.join(root, 'test-output/packed-plugin-'));
for (const [member, data] of contents) {
  const target = path.join(unpacked, ...member.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, data, { flag: 'wx' });
}
const plugin = await import(pathToFileURL(path.join(unpacked, 'package/src/plugin.js')));
const nativeTools = plugin.createToolDefinitions({});
assert.equal(nativeTools.length, 47);
assert.ok(nativeTools.some(tool => tool.name === 'paper_audit_prepare_image_audit'));
for (const member of ['src/nmr.js', 'src/image-duplicates.js', 'docs/NMR-AND-IMAGES.md']) assert.ok(members.includes('package/' + member), `Missing ${member}`);
for (const member of ['src/compounds.js', 'src/panels.js', 'src/spectrum-check.js', 'src/experimental-math.js', 'src/evaluation.js', 'src/scientific-config.js', 'docs/SCIENTIFIC-WORKFLOW.md', 'benchmarks/README.md']) assert.ok(members.includes('package/' + member), `Missing ${member}`);
for (const member of ['src/cross-check.js', 'src/revisions.js', 'src/experimental-prose.js', 'src/workflow.js', 'docs/WORKFLOW-0.5.md']) assert.ok(members.includes('package/' + member), `Missing ${member}`);
for (const member of ['src/molar-mass.js', 'src/average-weights.json', 'src/experiment-context.js', 'docs/EXPERIMENTS-0.6.md']) assert.ok(members.includes('package/' + member), `Missing ${member}`);
const standardMass = await import(pathToFileURL(path.join(unpacked, 'package/src/molar-mass.js')));
assert.equal(standardMass.calculateMolarMass('C2H6O').molarMassGmol, '46.069');
const massModule = await import(pathToFileURL(path.join(unpacked, 'package/src/hrms.js')));
const mass = massModule.calculateExactMass({ formula: 'C6H12O6', ion: '[M+H]+', formulaBasis: 'neutral' });
assert.equal(mass.status, 'calculated');
assert.ok(Math.abs(Number(mass.candidates[0].mz) - 181.0706645565) < 1e-8);
const imageModule = await import(pathToFileURL(path.join(unpacked, 'package/src/image-tables.js')));
assert.equal(typeof imageModule.readImageTable, 'function');
const checksum = createHash('sha256').update(await readFile(archive)).digest('hex');
const record = { checkedAt: new Date().toISOString(), name: manifest.name, version: manifest.version, hostTarget: manifest.engines.dsh, archive: path.basename(archive), sizeBytes: (await readFile(archive)).length, sha256: checksum, memberCount: members.length, members, excludedPrivateState: true, unpackedPluginEntry: 'package/src/plugin.js' };
Object.assign(record, { unpackedEntryImported: true, nativeToolCount: nativeTools.length, unpackedExactMassCheck: mass.candidates[0].mz, webAndServerAbsent: true });
try { const prior = JSON.parse(await readFile(path.join(root, 'dist/package-metadata.json'), 'utf8')); if (prior.version && prior.version !== manifest.version) await writeFile(path.join(root, `dist/package-metadata-${prior.version}.json`), JSON.stringify(prior, null, 2)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
await writeFile(path.join(root, `dist/package-metadata-${manifest.version}.json`), JSON.stringify(record, null, 2));
await writeFile(path.join(root, `dist/SHA256SUMS-${manifest.version}.txt`), `${checksum}  ${path.basename(archive)}\n`);
await writeFile(path.join(root, 'dist/package-metadata.json'), JSON.stringify(record, null, 2));
await writeFile(path.join(root, 'dist/SHA256SUMS.txt'), `${checksum}  ${path.basename(archive)}\n`);
console.log(JSON.stringify(record, null, 2));

for (const member of ['src/image-rules.js', 'src/review-groups.js', 'benchmarks/biofors-external.json', 'scripts/evaluate-external.js', 'scripts/fetch-biofors.py', 'docs/REVIEW-0.7.md']) assert.ok(members.includes('package/' + member), `Missing ${member}`);

for (const member of ['src/visual-review.js', 'src/visual-review-tools.js', 'docs/VISUAL-AGENT-0.8.md', 'scripts/prepare-visual-benchmark.js', 'scripts/evaluate-visual.js']) assert.ok(members.includes('package/' + member), `Missing ${member}`);
