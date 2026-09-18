#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDemo } from './demo-fixture.mjs';

const { folder, sessionDir } = await createDemo();
console.log(`Demo workspace: ${folder}\nWalk the stops, leave a reply, then choose Finish Review.`);
const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL('../packages/cli/dist/main.mjs', import.meta.url)),
    'open',
    '--session',
    sessionDir,
  ],
  { cwd: folder, stdio: 'inherit' },
);
process.exitCode = result.status ?? 1;
