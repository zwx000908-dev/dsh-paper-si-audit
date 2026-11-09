#!/usr/bin/env node
import path from 'node:path';
import { homedir } from 'node:os';
import { readFile, realpath, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseDocument, stringify } from 'yaml';

const PACKAGE = 'dsh-paper-si-audit';
const ROW = 'paper-si-audit';
export const HOST_TARGET = '0.2.2-rc.1';
const within = (base, target) => { const relative = path.relative(base, target); return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const expand = value => value === '~' ? homedir() : /^~[/\\]/.test(value) ? path.join(homedir(), value.slice(2)) : value;
const defaultHome = env => path.resolve(expand(env.DSH_HOME?.trim() || path.join(homedir(), '.dsh')));
async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }
async function optionalJson(file) { try { return await readJson(file); } catch (error) { if (error.code === 'ENOENT') return null; throw new Error(`Cannot read JSON metadata: ${path.basename(file)}`); } }
async function exists(file) { try { await stat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }

/** No plugin/module imports and no config code execution. Only the installed desktop CLI --version is run. */
async function desktopVersion(installDir) {
  if (!installDir) return { version: null, source: 'unavailable', note: 'Supply --desktop-dir or --host-version; a workspace dev dependency does not prove the desktop runtime version.' };
  const executable = path.join(installDir, 'DeepSeek Harness.exe');
  const cli = path.join(installDir, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
  if (!await exists(executable)) return { version: null, source: 'unavailable', note: 'Desktop executable was not found at the selected installation directory.' };
  const result = spawnSync(executable, ['--expose-internals', cli, '--version'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 10000,
    encoding: 'utf8', maxBuffer: 64 * 1024,
  });
  const output = result.stdout?.trim();
  if (result.status === 0 && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(output)) return { version: output, source: 'installed_desktop_cli' };
  return { version: null, source: 'unavailable', note: 'Desktop version command did not return one valid version; no logs or environment values are included.' };
}

async function safeYaml(file) {
  try {
    const text = await readFile(file, 'utf8');
    if (text.length > 2 * 1024 * 1024) return { entries: [], unknown: true };
    const doc = parseDocument(text, { maxAliasCount: 0, uniqueKeys: true });
    if (doc.errors.length || doc.warnings.length) return { entries: [], unknown: true };
    const value = doc.toJS({ maxAliasCount: 0 });
    return Array.isArray(value) ? { entries: value, unknown: false } : { entries: [], unknown: true };
  } catch (error) { if (error.code === 'ENOENT') return { entries: [], unknown: false }; return { entries: [], unknown: true }; }
}

function targetEntries(entries) {
  const found = [];
  for (const entry of entries) {
    if (!object(entry)) continue;
    if (Array.isArray(entry.insert)) for (const inserted of entry.insert) if (object(inserted) && (inserted.id === ROW || inserted.name === PACKAGE)) found.push({ row: inserted, inserted: true });
    if (entry.id === ROW || entry.name === PACKAGE) found.push({ row: entry, inserted: false });
  }
  return found;
}

/** Static, read-only diagnosis: installed/selected/configured/runtime-registration are separate states. */
export async function diagnoseHarness(options = {}) {
  const env = options.env ?? process.env;
  const home = path.resolve(expand(options.home ?? defaultHome(env)));
  const profile = options.profile ?? 'desktop';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(profile)) throw new Error('Invalid profile name');
  const profileDir = path.join(home, 'profiles', profile);
  const manifest = await optionalJson(path.join(profileDir, 'package.json'));
  const packageDir = path.join(profileDir, 'node_modules', PACKAGE);
  const installed = await optionalJson(path.join(packageDir, 'package.json'));
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
  const enabled = bundles.includes(PACKAGE);
  const checks = [];
  const problem = (code, level, message) => checks.push({ code, level, message });
  let runtime;
  if (options.hostVersion) {
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(options.hostVersion)) throw new Error('Invalid supplied host version');
    runtime = { version: options.hostVersion, source: 'user_supplied_not_runtime_verified' };
  }
  else {
    const desktopDir = options.desktopDir ?? (process.platform === 'win32' && env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness') : null);
    runtime = await desktopVersion(desktopDir);
  }
  runtime.target = HOST_TARGET;
  runtime.matchesTarget = runtime.version === HOST_TARGET;
  if (!manifest) problem('PROFILE_NOT_FOUND', 'error', 'Selected profile metadata was not found.');
  if (!installed) problem('PACKAGE_NOT_INSTALLED', 'error', 'Package metadata is absent in this profile node_modules; installed in another profile is a different state.');
  if (installed && !installed.dsh?.bundle?.patch) problem('BUNDLE_DECLARATION_MISSING', 'error', 'Installed package does not declare dsh.bundle.patch.');
  if (installed && !enabled) problem('BUNDLE_NOT_SELECTED', 'error', 'Installed package is absent from this profile dsh.profile.bundles. It is not activated by that bundle list.');
  if (!runtime.version) problem('RUNTIME_VERSION_UNKNOWN', 'warning', 'Active desktop runtime version was not verified.');
  else if (!runtime.matchesTarget) problem('RUNTIME_VERSION_MISMATCH', 'error', 'Runtime differs from the exact 0.2.2-rc.1 compatibility target; no exemption is proposed.');

  const locations = [];
  let unknownConfig = false;
  let selectedRow = false;
  let disabled = false;
  let config = {};
  const apply = (entries, layer, active) => {
    for (const item of targetEntries(entries)) {
      const row = item.row;
      locations.push({ layer, rowId: row.id ?? null, hasConfig: row.config !== undefined, disabled: typeof row.disabled === 'boolean' ? row.disabled : null, activeLayer: active });
      if (!active) continue;
      if (item.inserted || row.name === PACKAGE) selectedRow = true;
      if (typeof row.disabled === 'boolean') disabled = row.disabled;
      if (row.config !== undefined) { if (object(row.config)) config = row.config; else unknownConfig = true; }
    }
  };
  let patchReferences = installed?.dsh?.bundle?.patch;
  patchReferences = typeof patchReferences === 'string' ? [patchReferences] : Array.isArray(patchReferences) ? patchReferences : [];
  if (installed) for (const reference of patchReferences) {
    if (typeof reference !== 'string') { unknownConfig = true; continue; }
    try {
      const canonicalPackage = await realpath(packageDir);
      const target = await realpath(path.resolve(packageDir, reference));
      if (!within(canonicalPackage, target)) { unknownConfig = true; continue; }
      const result = await safeYaml(target); unknownConfig ||= result.unknown;
      apply(result.entries, 'package_default', enabled);
      if (!enabled) { // Show the package's declared defaults, but do not claim they are running.
        for (const { row } of targetEntries(result.entries)) if (object(row.config)) config = row.config;
      }
    } catch { unknownConfig = true; }
  }
  for (const [file, layer] of [[path.join(profileDir, 'cordis.patch.yml'), 'profile_override'], [path.join(home, 'cordis.patch.yml'), 'home_override']]) {
    const result = await safeYaml(file); unknownConfig ||= result.unknown;
    apply(result.entries, layer, true);
  }
  if (!enabled && selectedRow) {
    const selection = checks.find(check => check.code === 'BUNDLE_NOT_SELECTED');
    if (selection) { selection.level = 'warning'; selection.message = 'Bundle is not selected, but a visible direct target row may load the plugin independently. Verify the effective runtime and session tools.'; }
  }
  const roots = Array.isArray(config.allowedRoots) && config.allowedRoots.every(root => typeof root === 'string') ? config.allowedRoots : null;
  const safeRoots = [];
  if (roots) for (const root of roots) {
    let present = false;
    if (path.isAbsolute(root)) try { present = (await stat(root)).isDirectory(); } catch { /* retained as unavailable */ }
    safeRoots.push({ path: root, absolute: path.isAbsolute(root), existsAsDirectory: present });
  }
  if (disabled) problem('PLUGIN_ROW_DISABLED', 'error', 'A visible target row override explicitly disables this plugin.');
  if (!roots) problem('ALLOWED_ROOTS_UNKNOWN', 'warning', 'No complete static allowedRoots array was found; inspect the plugin effective configuration.');
  else if (!roots.length) problem('ALLOWED_ROOTS_EMPTY', 'error', 'No source directory is authorized. This blocks document imports; it does not by itself explain missing tool registration.');
  else if (safeRoots.some(root => !root.absolute || !root.existsAsDirectory)) problem('SOURCE_ROOT_INVALID', 'error', 'At least one configured source root is relative, missing, or not a directory.');
  if (unknownConfig) problem('STATIC_CONFIGURATION_INCOMPLETE', 'warning', 'Some config could not be safely interpreted; no custom tags, JS expressions, or plugin code were executed.');
  const dataDir = typeof config.dataDir === 'string' ? config.dataDir : null;
  if (dataDir && !path.isAbsolute(dataDir)) problem('DATA_DIRECTORY_RELATIVE', 'error', 'Plugin dataDir must be absolute.');

  const suggestedConfig = {};
  if (dataDir) suggestedConfig.dataDir = dataDir;
  if (roots) suggestedConfig.allowedRoots = roots;
  if (options.dataDir) suggestedConfig.dataDir = path.resolve(options.dataDir);
  if (options.sourceRoot) suggestedConfig.allowedRoots = [path.resolve(options.sourceRoot)];
  const requestedPreview = Boolean(options.dataDir || options.sourceRoot);
  const completePreview = requestedPreview && typeof suggestedConfig.dataDir === 'string' && Array.isArray(suggestedConfig.allowedRoots);
  const expectedCount = installed?.version === '0.2.0' ? 22 : /^0\.1\./.test(installed?.version ?? '') ? 14 : null;
  const suggestions = {
    bundleSelection: !enabled ? `Enable ${PACKAGE} in the selected profile using Harness plugin management; preserve all existing dsh.profile.bundles entries.` : null,
    profileOverridePreview: completePreview ? stringify([{ id: ROW, config: suggestedConfig }]) : null,
    previewNote: requestedPreview && !completePreview ? 'Supply both --data-dir and --source-root when current values are unknown; an incomplete replacement config is not generated.' : null,
    activationEvidence: `After enabling and setting the full config, reopen/restart as the host requires and verify ${expectedCount ? `all ${expectedCount}` : 'the installed version’s'} paper_audit_* tools in that actual session before claiming the native path passed.`,
  };
  return {
    readOnly: true, changedFiles: [], home, profile, profileDir,
    package: { name: PACKAGE, declaredDependency: Object.hasOwn(manifest?.dependencies ?? {}, PACKAGE), installed: Boolean(installed), version: installed?.version ?? null, engineRequirement: installed?.engines?.dsh ?? null, declaresBundle: Boolean(installed?.dsh?.bundle?.patch), selectedInProfileBundles: enabled },
    runtime,
    configuration: { visibleRowSelected: selectedRow, disabled, allowedRoots: safeRoots, rootsState: roots ? roots.length ? 'configured' : 'empty' : 'unknown', dataDir, visibleLayers: locations, confidence: 'static_subset_not_full_runtime_composition', excludedLayers: ['other bundle overrides', 'launch --patch overlays', 'live session tool restrictions'] },
    nativeTools: { state: 'not_observed_in_this_session', expectedCount, availableReleaseCount: 22, note: 'Expected count follows recognized installed metadata (0.1.x: 14; 0.2.0: 22); unknown versions are not guessed. Static metadata cannot prove current-session registration. Core AuditService results do not validate native discovery, guidance, permissions or lifecycle.' },
    checks, suggestions,
  };
}

async function main() {
  const options = {};
  const names = { home: 'home', profile: 'profile', 'host-version': 'hostVersion', 'desktop-dir': 'desktopDir', 'source-root': 'sourceRoot', 'data-dir': 'dataDir' };
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log('Read-only Harness activation doctor\nnode scripts/doctor-harness.js [--home DIR] [--profile desktop] [--desktop-dir DIR] [--source-root DIR] [--data-dir DIR]\n--host-version VERSION labels version as supplied, not runtime-verified. No changes, installs, activation, grants or network requests are made.'); return; }
  for (let i = 0; i < args.length; i += 2) {
    const key = names[args[i]?.replace(/^--/, '')];
    if (!key || args[i + 1] === undefined) throw new Error('Unknown or missing option; use --help');
    options[key] = args[i + 1];
  }
  console.log(JSON.stringify(await diagnoseHarness(options), null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
