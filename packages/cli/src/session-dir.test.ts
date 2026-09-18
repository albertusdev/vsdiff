import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import {
  findLatestSessionDir,
  findRepoRoot,
  findSessionsRoot,
  resolveSessionDir,
  SessionDirError,
} from './session-dir.ts';

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.length = 0;
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'vsdiff-cli-session-'));
  tempRoots.push(root);
  return root;
}

/** A session dir with a session.json whose mtime is pinned (epoch seconds). */
function makeSession(root: string, name: string, mtimeSeconds: number): string {
  const dir = join(root, '.vsdiff', 'sessions', name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'session.json');
  writeFileSync(file, `{"version":1,"title":"${name}"}\n`, 'utf8');
  utimesSync(file, mtimeSeconds, mtimeSeconds);
  return dir;
}

test('explicit --session wins over the newest session', async () => {
  const root = makeRoot();
  const older = makeSession(root, '2026-08-01-older', 1_700_000_000);
  makeSession(root, '2026-08-19-newer', 1_800_000_000);

  expect(await resolveSessionDir(older, root)).toBe(older);
});

test('explicit --session accepts a path to session.json and resolves relatives', async () => {
  const root = makeRoot();
  const dir = makeSession(root, 'only', 1_700_000_000);

  expect(await resolveSessionDir(join(dir, 'session.json'), root)).toBe(dir);
  expect(await resolveSessionDir(join('.vsdiff', 'sessions', 'only'), root)).toBe(dir);
});

test('explicit --session that does not exist fails with the path in the message', async () => {
  const root = makeRoot();
  await expect(resolveSessionDir(join(root, 'nope'), root)).rejects.toBeInstanceOf(SessionDirError);
  await expect(resolveSessionDir(join(root, 'nope'), root)).rejects.toThrow(/nope/);
});

test('newest session.json mtime wins', async () => {
  const root = makeRoot();
  makeSession(root, 'a-first', 1_700_000_000);
  const newest = makeSession(root, 'b-second', 1_900_000_000);
  makeSession(root, 'c-third', 1_800_000_000);

  expect(await findLatestSessionDir(root)).toBe(newest);
  expect(await resolveSessionDir(undefined, root)).toBe(newest);
});

test('equal mtimes break by name, so the pick is deterministic', async () => {
  const root = makeRoot();
  makeSession(root, '2026-08-01-a', 1_700_000_000);
  const later = makeSession(root, '2026-08-19-b', 1_700_000_000);

  expect(await findLatestSessionDir(root)).toBe(later);
});

test('a directory without session.json is not a session', async () => {
  const root = makeRoot();
  mkdirSync(join(root, '.vsdiff', 'sessions', 'scratch'), { recursive: true });
  const real = makeSession(root, 'real', 1_700_000_000);

  expect(await findLatestSessionDir(root)).toBe(real);
});

test('discovery walks up from a nested cwd', async () => {
  const root = makeRoot();
  const dir = makeSession(root, 'only', 1_700_000_000);
  const nested = join(root, 'src', 'auth');
  mkdirSync(nested, { recursive: true });

  expect(await findSessionsRoot(nested)).toBe(join(root, '.vsdiff', 'sessions'));
  expect(await resolveSessionDir(undefined, nested)).toBe(dir);
});

test('no session anywhere fails with a message naming the search path', async () => {
  const root = makeRoot();
  expect(await findLatestSessionDir(root)).toBeNull();
  await expect(resolveSessionDir(undefined, root)).rejects.toBeInstanceOf(SessionDirError);
  await expect(resolveSessionDir(undefined, root)).rejects.toThrow(/\.vsdiff.*sessions/);
  await expect(resolveSessionDir(undefined, root)).rejects.toThrow(/vsdiff new/);
});

test('an empty sessions dir is treated as no session', async () => {
  const root = makeRoot();
  mkdirSync(join(root, '.vsdiff', 'sessions'), { recursive: true });

  expect(await findLatestSessionDir(root)).toBeNull();
});

test('findRepoRoot walks up to the nearest .git', async () => {
  const root = makeRoot();
  mkdirSync(join(root, '.git'), { recursive: true });
  const dir = makeSession(root, 'only', 1_700_000_000);

  expect(await findRepoRoot(dir)).toBe(root);

  // A nested checkout (submodule, fixture repo) wins over the outer one.
  const inner = join(root, 'fixtures', 'l-repo');
  mkdirSync(join(inner, '.git'), { recursive: true });
  expect(await findRepoRoot(join(inner, 'src'))).toBe(inner);
  // No .git-free case here: the shared tmpdir can't guarantee one (this machine
  // has a stray /tmp/.git), and the null branch is a plain loop exit.
});
