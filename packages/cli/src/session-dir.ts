// Which session a P2 verb acts on. Every feedback verb takes `--session <dir>`;
// without one the agent is assumed to mean the review it just scaffolded, so we
// pick the newest `.vsdiff/sessions/*/session.json` and use its directory.

import { access, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export class SessionDirError extends Error {
  override readonly name = 'SessionDirError';
}

const SESSIONS_DIR = join('.vsdiff', 'sessions');
const SESSION_FILE = 'session.json';

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Sessions in `<root>/.vsdiff/sessions`, newest first by the mtime of their
 * `session.json` (the file the agent rewrites as it authors). Ties break by
 * name, which is date-prefixed, so the pick is deterministic on filesystems
 * with coarse timestamps.
 */
async function newestSessionIn(sessionsRoot: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(sessionsRoot);
  } catch {
    return null;
  }
  let best: { dir: string; mtimeMs: number; name: string } | null = null;
  for (const name of entries.sort()) {
    const dir = join(sessionsRoot, name);
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(join(dir, SESSION_FILE))).mtimeMs;
    } catch {
      continue;
    }
    if (best === null || mtimeMs > best.mtimeMs || (mtimeMs === best.mtimeMs && name > best.name)) {
      best = { dir, mtimeMs, name };
    }
  }
  return best === null ? null : best.dir;
}

/**
 * The nearest `.vsdiff/sessions` at or above `cwd` — an agent servicing feedback
 * is often deep in the tree it just edited, not at the repo root.
 */
export async function findSessionsRoot(cwd: string): Promise<string | null> {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, SESSIONS_DIR);
    if (await isDirectory(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The newest session directory at or above `cwd`, or null when there is none. */
export async function findLatestSessionDir(cwd: string): Promise<string | null> {
  const root = await findSessionsRoot(cwd);
  return root === null ? null : newestSessionIn(root);
}

/**
 * Explicit `--session` wins and is taken literally (pointing it at a
 * `session.json` is accepted too — that is what `vsdiff new --json` prints).
 */
export async function resolveSessionDir(
  explicit: string | undefined,
  cwd: string = process.cwd(),
): Promise<string> {
  if (explicit !== undefined && explicit.length > 0) {
    const target = resolve(cwd, explicit);
    const dir = basename(target) === SESSION_FILE ? dirname(target) : target;
    if (!(await isDirectory(dir))) {
      throw new SessionDirError(`--session ${explicit}: no such directory (${dir})`);
    }
    return dir;
  }
  const found = await findLatestSessionDir(cwd);
  if (found === null) {
    throw new SessionDirError(
      `no session found in ${join(cwd, SESSIONS_DIR)} — run \`vsdiff new\` first, or pass --session <dir>`,
    );
  }
  return found;
}

/** Repo root for the editor launch: nearest ancestor with a `.git`, else null. */
export async function findRepoRoot(startDir: string): Promise<string | null> {
  let dir = resolve(startDir);
  for (;;) {
    try {
      await access(join(dir, '.git'));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
}
