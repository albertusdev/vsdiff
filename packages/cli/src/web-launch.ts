// The `editor: "web"` target (docs/design/open-in-vsdiff.html §2): one shared
// local `code serve-web` daemon with the vsdiff extension installed, and
// `vsdiff open` becomes a browser tab on it. Mechanics are ported from the dev
// harness (scripts/web.mjs) with daily-use behavior: the daemon is reused, the
// extension reinstalls only when its version changed, and user-tweaked
// settings in the instance are left alone.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VsdiffConfig } from '@vsdiff/core';

export type Env = Record<string, string | undefined>;

export interface WebSettings {
  port: number;
  dataDir: string;
  /** Sibling of dataDir: web.log lives here. */
  stateDir: string;
}

const DEFAULT_PORT = 3123;

// Keep workspace trust enabled: a review folder can contain executable content.
const INSTANCE_SETTINGS = {
  'workbench.startupEditor': 'none',
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'comments.openView': 'never',
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
};

function expandHome(path: string, env: Env): string {
  if (path === '~') return env.HOME ?? homedir();
  if (path.startsWith('~/')) return join(env.HOME ?? homedir(), path.slice(2));
  return path;
}

export function webSettings(config: VsdiffConfig, env: Env = process.env): WebSettings {
  const raw = config.web ?? {};
  const port =
    typeof raw.port === 'number' && Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536
      ? raw.port
      : DEFAULT_PORT;
  const xdg = env.XDG_CACHE_HOME;
  const cache =
    xdg !== undefined && xdg.trim() !== '' ? xdg : join(env.HOME ?? homedir(), '.cache');
  const stateDir = join(cache, 'vsdiff');
  const dataDir =
    typeof raw.dataDir === 'string' && raw.dataDir.trim() !== ''
      ? expandHome(raw.dataDir, env)
      : join(stateDir, 'serve-web');
  return { port, dataDir, stateDir };
}

/** serve-web takes the folder as a plain query param (harness-proven form). */
export function folderUrl(port: number, dir: string, token?: string): string {
  const url = new URL(`http://localhost:${port}/`);
  url.searchParams.set('folder', dir);
  if (token) url.searchParams.set('tkn', token);
  return url.toString();
}

export function ensureConnectionToken(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, 'connection-token');
  try {
    writeFileSync(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) {
    throw new Error('connection-token must be a regular file');
  }
  chmodSync(file, 0o600);
  const token = readFileSync(file, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('invalid connection-token file');
  return token;
}

async function responds(port: number, token?: string): Promise<number | null> {
  try {
    const url = new URL(`http://127.0.0.1:${port}/`);
    if (token) url.searchParams.set('tkn', token);
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(2000),
    });
    return response.status;
  } catch {
    return null;
  }
}

/** Newest downloaded serve-web server binary, or null before the first run. */
function findCodeServer(env: Env): string | null {
  const base = join(env.HOME ?? homedir(), '.vscode', 'cli', 'serve-web');
  if (!existsSync(base)) return null;
  const commits = readdirSync(base).filter((name) =>
    existsSync(join(base, name, 'bin', 'code-server')),
  );
  if (commits.length === 0) return null;
  commits.sort((a, b) => statSync(join(base, b)).mtimeMs - statSync(join(base, a)).mtimeMs);
  return join(base, commits[0] ?? '', 'bin', 'code-server');
}

/** Walks up from the CLI bundle looking for dist/vsdiff.vsix (repo installs). */
export function locateVsix(startDir: string): string | null {
  let dir = startDir;
  for (let depth = 0; depth < 6; depth++) {
    const candidate = join(dir, 'dist', 'vsdiff.vsix');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** True when `extensions/vsdiff.vsdiff-<version>` is already extracted. */
function extensionCurrent(dataDir: string, version: string): boolean {
  return existsSync(join(dataDir, 'extensions', `vsdiff.vsdiff-${version}`));
}

function installExtension(dataDir: string, version: string, env: Env): string | null {
  if (extensionCurrent(dataDir, version)) return null;
  const codeServer = findCodeServer(env);
  if (codeServer === null) return 'serve-web server not downloaded yet';
  const vsix = locateVsix(dirname(fileURLToPath(import.meta.url)));
  if (vsix === null) return 'dist/vsdiff.vsix not found — run pnpm build in the vsdiff checkout';
  const extensionsDir = join(dataDir, 'extensions');
  // Let the editor replace its own version; preserve every other extension.
  mkdirSync(extensionsDir, { recursive: true });
  const result = spawnSync(
    codeServer,
    ['--install-extension', vsix, '--extensions-dir', extensionsDir, '--force'],
    { encoding: 'utf8' },
  );
  return result.status === 0 ? null : `vsix install failed: ${result.stderr || result.stdout}`;
}

function ensureInstanceSettings(dataDir: string): void {
  for (const scope of ['User', 'Machine']) {
    const dir = join(dataDir, 'data', scope);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'settings.json');
    // Write-once: the instance belongs to vsdiff, but settings the user changed
    // through its UI stay theirs.
    if (!existsSync(file)) writeFileSync(file, JSON.stringify(INSTANCE_SETTINGS, null, 2));
  }
}

async function waitForHttp(port: number, token: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await responds(port, token)) === 302) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function startDaemon(settings: WebSettings): void {
  mkdirSync(settings.stateDir, { recursive: true });
  const log = openSync(join(settings.stateDir, 'web.log'), 'a');
  const child = spawn(
    'code',
    [
      'serve-web',
      '--port',
      String(settings.port),
      '--host',
      '127.0.0.1',
      '--connection-token-file',
      join(settings.dataDir, 'connection-token'),
      '--disable-telemetry',
      '--accept-server-license-terms',
      '--server-data-dir',
      settings.dataDir,
    ],
    { detached: true, stdio: ['ignore', log, log] },
  );
  child.on('error', () => {
    // Reported by the HTTP wait timing out; the log carries the detail.
  });
  child.unref();
}

export interface WebLaunchResult {
  url: string;
  /** True when the daemon was started by this call (vs already answering). */
  started: boolean;
  /** Non-fatal problems worth telling the user about. */
  warnings: string[];
}

/**
 * Ensures the daemon and the extension, then returns the tab URL to open.
 * First-ever run: the daemon start also downloads the server binary, so the
 * extension install happens after the daemon answers — new windows pick it up
 * (extension hosts are per-window and scan the extensions dir when one opens).
 */
export async function ensureWeb(
  config: VsdiffConfig,
  repoRoot: string,
  version: string,
  env: Env = process.env,
): Promise<WebLaunchResult | { error: string }> {
  const settings = webSettings(config, env);
  const warnings: string[] = [];
  const token = ensureConnectionToken(settings.dataDir);
  ensureInstanceSettings(settings.dataDir);

  const anonymous = await responds(settings.port);
  const up = anonymous !== null;
  if (up && (anonymous !== 403 || (await responds(settings.port, token)) !== 302)) {
    return {
      error: `port ${settings.port} is occupied by an unprotected or different server. Stop the old vsdiff server with 'vsdiff web stop', or choose another port in your user config.`,
    };
  }
  if (!up && findCodeServer(env) !== null) {
    // Normal path: install/refresh the extension before the first window opens.
    const failed = installExtension(settings.dataDir, version, env);
    if (failed !== null) warnings.push(failed);
  }
  if (!up) {
    startDaemon(settings);
    const ok = await waitForHttp(settings.port, token, 120_000);
    if (!ok) {
      return {
        error: `serve-web did not answer on port ${settings.port} — see ${join(settings.stateDir, 'web.log')} (is \`code\` installed?)`,
      };
    }
  }
  // Covers both the already-running daemon and the first-ever run.
  const failed = installExtension(settings.dataDir, version, env);
  if (failed !== null) warnings.push(failed);

  return { url: folderUrl(settings.port, repoRoot, token), started: !up, warnings };
}

/** Opens the default browser on the URL, detached; failures are non-fatal. */
export function openBrowser(url: string, env: Env = process.env): boolean {
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    const child = spawn(opener, [url], { detached: true, stdio: 'ignore', env: env as never });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** `vsdiff web stop`: terminate the daemon for this data dir. */
export function stopDaemon(settings: WebSettings): void {
  const escaped = settings.dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  spawnSync('pkill', ['-f', '--', `server-data-dir[= ]${escaped}(/data)?( |$)`]);
}

export async function daemonStatus(settings: WebSettings): Promise<string> {
  const up = (await responds(settings.port)) !== null;
  return up
    ? `serve-web answering on http://localhost:${settings.port}/ (data: ${settings.dataDir})`
    : `serve-web not running on port ${settings.port}`;
}
