import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
for (const dir of ['src', 'scripts']) for (const file of readdirSync(path.join(root, dir))) if (file.endsWith('.js')) execFileSync(process.execPath, ['--check', path.join(root, dir, file)], { windowsHide: true, stdio: 'inherit' });
console.log('All source and script JavaScript syntax checks passed.');
