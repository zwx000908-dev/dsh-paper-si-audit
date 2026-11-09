import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const npmCli = process.env.npm_execpath;
if (!npmCli || !path.isAbsolute(npmCli)) throw new Error('Run this release check with npm run pack:verify from a source checkout.');
await mkdir(path.join(root, 'dist'), { recursive: true });
execFileSync(process.execPath, [npmCli, 'pack', '--pack-destination', 'dist', '--ignore-scripts', '--json'], { cwd: root, stdio: 'inherit', windowsHide: true });
await import('./verify-package.js');
