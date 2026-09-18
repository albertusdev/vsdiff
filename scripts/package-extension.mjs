#!/usr/bin/env node
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extension = join(root, 'packages', 'extension');
mkdirSync(join(root, 'dist'), { recursive: true });
// VSIX must carry the same license as the source distribution.
copyFileSync(join(root, 'LICENSE'), join(extension, 'LICENSE'));
try {
  const result = spawnSync(
    'pnpm',
    ['exec', 'vsce', 'package', '--no-dependencies', '-o', join(root, 'dist/vsdiff.vsix')],
    { cwd: extension, stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(join(extension, 'LICENSE'), { force: true });
}
