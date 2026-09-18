#!/usr/bin/env node
// Dev-install the vsdiff CLI: a ~/.local/bin/vsdiff wrapper pointing at this
// checkout's built dist. Idempotent; rerun any time. (Published installs come
// via npm in P6 — this is the dogfood path.)

import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'packages', 'cli', 'dist', 'main.mjs');
const BIN_DIR = join(homedir(), '.local', 'bin');
const BIN = join(BIN_DIR, 'vsdiff');

if (!existsSync(ENTRY)) {
  console.error(`[install-cli] ${ENTRY} missing — run \`pnpm build\` first`);
  process.exit(1);
}
mkdirSync(BIN_DIR, { recursive: true });
// Pin the node that ran this installer: a bare `node` breaks in non-interactive
// shells (ssh, GUI-spawned agents) where homebrew/nvm isn't on PATH. Fall back
// to PATH lookup only if that binary ever disappears.
writeFileSync(
  BIN,
  `#!/usr/bin/env bash\nNODE="${process.execPath}"\n[ -x "$NODE" ] || NODE=node\nexec "$NODE" "${ENTRY}" "$@"\n`,
);
chmodSync(BIN, 0o755);
console.log(`[install-cli] ${BIN} → ${ENTRY}`);
