#!/usr/bin/env node
// serve-web harness (blueprint §5): lifecycle for a local VS Code web instance
// with the vsdiff extension installed, isolated under .dev/web. Commands:
//   start    detached server (idempotent), stop, restart, status
//   run      foreground server — used as Playwright's webServer command
//   install  build nothing, just (re)install dist/vsdiff.vsix into the instance

import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  openSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEV = join(ROOT, '.dev');
// The server data (incl. its extensions dir) must live OUTSIDE any reviewed
// workspace: an untrusted workspace refuses to load extensions residing inside
// itself, which silently killed vsdiff when reviewing vsdiff's own repo.
const WEB_DATA = join(
  process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'),
  'vsdiff-dev',
  'serve-web',
);
const PORT = Number(process.env.VSDIFF_WEB_PORT ?? 3111);
const URL = `http://localhost:${PORT}/`;
const PID_FILE = join(DEV, 'web.pid');
const LOG_FILE = join(DEV, 'web.log');
const BRIDGE_FILE = join(DEV, 'bridge.json');
const TOKEN_FILE = join(DEV, 'web-token');
const VSIX = join(ROOT, 'dist', 'vsdiff.vsix');

const SETTINGS = {
  'security.workspace.trust.enabled': false,
  'workbench.startupEditor': 'none',
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'workbench.enableExperiments': false,
  'comments.openView': 'never',
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
};

function ensureSettings() {
  if (!existsSync(TOKEN_FILE))
    writeFileSync(TOKEN_FILE, randomBytes(32).toString('hex'), { mode: 0o600 });
  for (const scope of ['User', 'Machine']) {
    const dir = join(WEB_DATA, 'data', scope);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(SETTINGS, null, 2));
  }
}

function findCodeServer() {
  const base = join(homedir(), '.vscode', 'cli', 'serve-web');
  if (!existsSync(base)) {
    return null;
  }
  const commits = readdirSync(base).filter((name) =>
    existsSync(join(base, name, 'bin', 'code-server')),
  );
  if (commits.length === 0) {
    return null;
  }
  commits.sort((a, b) => statSync(join(base, b)).mtimeMs - statSync(join(base, a)).mtimeMs);
  return join(base, commits[0], 'bin', 'code-server');
}

function installVsix() {
  if (!existsSync(VSIX)) {
    throw new Error(`${VSIX} missing — run \`pnpm build\` first`);
  }
  const codeServer = findCodeServer();
  if (!codeServer) throw new Error('VS Code server download has not completed');
  const extensionsDir = join(WEB_DATA, 'extensions');
  // Same-version reinstalls are silently skipped even with --force; this dir
  // only ever holds our extension, so wipe it for a guaranteed-fresh extract.
  rmSync(extensionsDir, { recursive: true, force: true });
  mkdirSync(extensionsDir, { recursive: true });
  const result = spawnSync(
    codeServer,
    ['--install-extension', VSIX, '--extensions-dir', extensionsDir, '--force'],
    {
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) {
    throw new Error(`vsix install failed:\n${result.stdout}\n${result.stderr}`);
  }
  console.log(`[web] installed ${VSIX}`);
}

function runningPid() {
  if (!existsSync(PID_FILE)) return null;
  const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
  if (!Number.isFinite(pid)) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

async function waitForHttp(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${URL}?tkn=${readFileSync(TOKEN_FILE, 'utf8')}`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(2000),
      });
      if (response.status === 302) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`serve-web did not answer 200 on ${URL} within ${timeoutMs}ms — see ${LOG_FILE}`);
}

function serveWebArgs() {
  return [
    'serve-web',
    '--port',
    String(PORT),
    '--host',
    '127.0.0.1',
    '--connection-token-file',
    TOKEN_FILE,
    '--disable-telemetry',
    '--accept-server-license-terms',
    '--server-data-dir',
    WEB_DATA,
  ];
}

function serveWebEnv() {
  return { ...process.env, VSDIFF_DEV_BRIDGE: '1', VSDIFF_DEV_BRIDGE_FILE: BRIDGE_FILE };
}

async function start() {
  if (runningPid()) {
    console.log(`[web] already running (pid ${runningPid()}) on ${URL}`);
    return;
  }
  mkdirSync(DEV, { recursive: true });
  ensureSettings();
  const downloaded = findCodeServer() !== null;
  if (downloaded) installVsix();
  rmSync(BRIDGE_FILE, { force: true });
  const log = openSync(LOG_FILE, 'a');
  const child = spawn('code', serveWebArgs(), {
    detached: true,
    stdio: ['ignore', log, log],
    env: serveWebEnv(),
  });
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
  await waitForHttp(120_000);
  if (!downloaded) installVsix();
  console.log(`[web] up on ${URL} (pid ${child.pid})`);
}

async function runForeground() {
  await stop();
  mkdirSync(DEV, { recursive: true });
  ensureSettings();
  const downloaded = findCodeServer() !== null;
  if (downloaded) installVsix();
  rmSync(BRIDGE_FILE, { force: true });
  const child = spawn('code', serveWebArgs(), { stdio: 'inherit', env: serveWebEnv() });
  writeFileSync(PID_FILE, String(child.pid));
  await waitForHttp(120_000);
  if (!downloaded) installVsix();
  await new Promise((resolveExit) => child.on('exit', resolveExit));
}

async function stop() {
  const pid = runningPid();
  if (pid) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
    console.log(`[web] stopped pid ${pid}`);
  }
  // serve-web spawns a separate server process that can outlive the CLI.
  spawnSync('pkill', ['-f', `server-data-dir ${WEB_DATA}`]);
  spawnSync('pkill', ['-f', `serve-web --port ${PORT}`]);
  rmSync(PID_FILE, { force: true });
  await new Promise((r) => setTimeout(r, 500));
}

async function status() {
  try {
    const response = await fetch(URL, { signal: AbortSignal.timeout(2000) });
    console.log(`[web] ${URL} → ${response.status}; pid ${runningPid() ?? 'unknown'}`);
  } catch {
    console.log(`[web] not responding on ${URL}`);
  }
}

const command = process.argv[2] ?? 'start';
try {
  if (command === 'start') await start();
  else if (command === 'run') await runForeground();
  else if (command === 'stop') await stop();
  else if (command === 'restart') {
    await stop();
    await start();
  } else if (command === 'install') installVsix();
  else if (command === 'status') await status();
  else {
    console.error(`unknown command: ${command} (start|run|stop|restart|install|status)`);
    process.exit(2);
  }
} catch (error) {
  console.error(`[web] ${error.message}`);
  process.exit(1);
}
