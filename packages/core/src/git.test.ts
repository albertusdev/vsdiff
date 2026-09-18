import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { computeDiff, diffstat, GitError, showFile } from './git.ts';

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.length = 0;
});

interface Repo {
  root: string;
  git: (...args: string[]) => string;
  write: (path: string, content: string | Uint8Array) => void;
  commit: (message: string) => string;
}

/** A throwaway repo, cut off from the developer's global/system git config. */
function makeRepo(): Repo {
  const root = mkdtempSync(join(tmpdir(), 'vsdiff-git-'));
  tempRoots.push(root);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(root, 'absent-global-config'),
    GIT_CONFIG_SYSTEM: join(root, 'absent-system-config'),
    GIT_AUTHOR_NAME: 'Fixture Bot',
    GIT_AUTHOR_EMAIL: 'fixture@vsdiff.invalid',
    GIT_COMMITTER_NAME: 'Fixture Bot',
    GIT_COMMITTER_EMAIL: 'fixture@vsdiff.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  };
  const git = (...args: string[]): string =>
    execFileSync('git', args, {
      cwd: root,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  git('init', '-b', 'main');
  return {
    root,
    git,
    write(path, content) {
      const full = join(root, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    },
    commit(message) {
      git('add', '-A');
      git('commit', '-m', message);
      return git('rev-parse', 'HEAD').trim();
    },
  };
}

const lines = (count: number, start = 1): string =>
  `${Array.from({ length: count }, (_, i) => `line${start + i}`).join('\n')}\n`;

test('reviewing a diff never executes a configured textconv driver', async () => {
  const repo = makeRepo();
  repo.write('.gitattributes', '*.txt diff=probe\n');
  repo.write('a.txt', 'before\n');
  repo.commit('base');
  repo.write('probe.sh', '#!/bin/sh\ntouch executed\ncat "$1"\n');
  chmodSync(join(repo.root, 'probe.sh'), 0o755);
  repo.git('config', 'diff.probe.textconv', './probe.sh');
  repo.write('a.txt', 'after\n');
  const diff = await computeDiff(repo.root, { type: 'working-tree' });
  expect(diff.files.find((file) => file.path === 'a.txt')?.hunks[0]?.text).toContain('+after');
  expect(existsSync(join(repo.root, 'executed'))).toBe(false);
});

test('reviewing a diff never executes a configured filesystem monitor', async () => {
  const repo = makeRepo();
  repo.write('a.txt', 'before\n');
  repo.commit('base');
  repo.write('probe.sh', '#!/bin/sh\ntouch executed\nprintf "token\\0/\\0"\n');
  chmodSync(join(repo.root, 'probe.sh'), 0o755);
  repo.git('config', 'core.fsmonitor', './probe.sh');
  repo.write('a.txt', 'after\n');
  const diff = await computeDiff(repo.root, { type: 'working-tree' });
  expect(diff.files.find((file) => file.path === 'a.txt')?.hunks[0]?.text).toContain('+after');
  expect(existsSync(join(repo.root, 'executed'))).toBe(false);
});

test('working-tree: single-hunk modify', async () => {
  const repo = makeRepo();
  repo.write('src/a.ts', lines(5));
  const head = repo.commit('base');
  repo.write('src/a.ts', lines(5).replace('line3\n', 'line3 changed\n'));

  const diff = await computeDiff(repo.root, { type: 'working-tree' });

  expect(diff.repoRoot).toBe(repo.root);
  expect(diff.headSha).toBe(head);
  expect(diff.files).toHaveLength(1);
  const [file] = diff.files;
  expect(file?.path).toBe('src/a.ts');
  expect(file?.status).toBe('modified');
  expect(file?.binary).toBe(false);
  expect(file?.additions).toBe(1);
  expect(file?.deletions).toBe(1);
  expect(file?.hunks).toHaveLength(1);
  expect(file?.hunks[0]?.id).toBe('src/a.ts:h1');
  expect(file?.hunks[0]?.header).toMatch(/^@@ -1,5 \+1,5 @@/);
  expect(file?.hunks[0]?.text).toContain('-line3\n');
  expect(file?.hunks[0]?.text).toContain('+line3 changed\n');
});

test('working-tree: multi-hunk modify keeps h1/h2 order and line numbers', async () => {
  const repo = makeRepo();
  repo.write('src/multi.ts', lines(30));
  repo.commit('base');
  repo.write(
    'src/multi.ts',
    lines(30).replace('line2\n', 'line2 changed\n').replace('line25\n', 'line25 changed\n'),
  );

  const diff = await computeDiff(repo.root, { type: 'working-tree' });
  const [file] = diff.files;

  expect(file?.hunks.map((hunk) => hunk.id)).toEqual(['src/multi.ts:h1', 'src/multi.ts:h2']);
  expect(file?.hunks.map((hunk) => hunk.n)).toEqual([1, 2]);
  expect(file?.hunks[0]?.oldStart).toBe(1);
  expect(file?.hunks[0]?.oldLines).toBe(5);
  expect(file?.hunks[0]?.newStart).toBe(1);
  expect(file?.hunks[1]?.oldStart).toBe(22);
  expect(file?.hunks[1]?.oldLines).toBe(7);
  expect(file?.hunks[1]?.newStart).toBe(22);
  expect(file?.hunks[0]?.text).toContain('+line2 changed\n');
  expect(file?.hunks[1]?.text).toContain('+line25 changed\n');
  expect(file?.additions).toBe(2);
  expect(file?.deletions).toBe(2);
});

test('working-tree: untracked files are invisible until staged', async () => {
  const repo = makeRepo();
  repo.write('tracked.txt', 'one\n');
  repo.commit('base');
  repo.write('tracked.txt', 'two\n');
  repo.write('untracked.txt', 'brand new\n');

  const before = await computeDiff(repo.root, { type: 'working-tree' });
  expect(before.files.map((file) => file.path)).toEqual(['tracked.txt']);

  repo.git('add', 'untracked.txt');
  const after = await computeDiff(repo.root, { type: 'working-tree' });
  expect(after.files.map((file) => file.path)).toEqual(['tracked.txt', 'untracked.txt']);
  expect(after.files[1]?.status).toBe('added');
});

test('staged sees only the index; working-tree sees staged plus unstaged', async () => {
  const repo = makeRepo();
  repo.write('a.txt', 'a\n');
  repo.write('b.txt', 'b\n');
  const head = repo.commit('base');
  repo.write('a.txt', 'a staged\n');
  repo.git('add', 'a.txt');
  repo.write('b.txt', 'b unstaged\n');

  const staged = await computeDiff(repo.root, { type: 'staged' });
  expect(staged.files.map((file) => file.path)).toEqual(['a.txt']);
  expect(staged.headSha).toBe(head);

  repo.write('a.txt', 'a later unstaged edit\n');
  expect(new TextDecoder().decode((await showFile(repo.root, '', 'a.txt'))!)).toBe('a staged\n');
  const worktree = await computeDiff(repo.root, { type: 'working-tree' });
  expect(worktree.files.map((file) => file.path)).toEqual(['a.txt', 'b.txt']);
});

test('commit source diffs the commit against its parent', async () => {
  const repo = makeRepo();
  repo.write('a.txt', 'one\n');
  repo.commit('base');
  repo.write('a.txt', 'two\n');
  repo.write('b.txt', 'new\n');
  const head = repo.commit('second');
  // A later commit must not bleed into the diff of `head`.
  repo.write('c.txt', 'later\n');
  repo.commit('third');

  const diff = await computeDiff(repo.root, { type: 'commit', head });

  expect(diff.headSha).toBe(head);
  expect(diff.files.map((file) => file.path)).toEqual(['a.txt', 'b.txt']);
  expect(diff.files[0]?.status).toBe('modified');
  expect(diff.files[1]?.status).toBe('added');
});

test('commit source handles a root commit via the empty tree', async () => {
  const repo = makeRepo();
  repo.write('a.txt', 'one\ntwo\n');
  repo.write('dir/b.txt', 'three\n');
  const root = repo.commit('root');

  const diff = await computeDiff(repo.root, { type: 'commit', head: root });

  expect(diff.headSha).toBe(root);
  expect(diff.files.map((file) => file.path)).toEqual(['a.txt', 'dir/b.txt']);
  expect(diff.files.every((file) => file.status === 'added')).toBe(true);
  expect(diffstat(diff).additions).toBe(3);
});

test('range source is three-dot: commits added to base after branching are excluded', async () => {
  const repo = makeRepo();
  repo.write('shared.txt', 'base\n');
  const base = repo.commit('base');
  repo.git('checkout', '-b', 'feature');
  repo.write('feature.txt', 'from feature\n');
  const head = repo.commit('feature work');
  repo.git('checkout', 'main');
  repo.write('only-on-main.txt', 'moved on after branching\n');
  repo.commit('main moves on');
  repo.git('checkout', 'feature');

  const diff = await computeDiff(repo.root, { type: 'range', base: 'main', head: 'feature' });

  expect(diff.baseRef).toBe(base);
  expect(diff.files.map((file) => file.path)).toEqual(['feature.txt']);
  expect(diff.headSha).toBe(head);
});

test('add, delete, pure rename, rename+edit, binary and mode-only in one commit', async () => {
  const repo = makeRepo();
  repo.write('keep.txt', 'keep\n');
  repo.write('gone.txt', 'del\nme\n');
  repo.write('torename.txt', 'stable\ncontent\nhere\n');
  repo.write('seed.txt', lines(10));
  repo.write('mode.txt', 'exec me\n');
  repo.write('blob.bin', new Uint8Array([0, 1, 2, 3, 250]));
  repo.commit('base');

  rmSync(join(repo.root, 'gone.txt'));
  repo.git('mv', 'torename.txt', 'renamed.txt');
  repo.git('mv', 'seed.txt', 'moved.txt');
  // Stays above git's default 50% rename similarity, so this is a rename+edit.
  repo.write('moved.txt', lines(10).replace('line5\n', 'line5 changed\n'));
  repo.write('added.txt', 'brand\nnew\n');
  repo.write('blob.bin', new Uint8Array([9, 9, 9, 0, 1]));
  chmodSync(join(repo.root, 'mode.txt'), 0o755);
  const head = repo.commit('everything');

  const diff = await computeDiff(repo.root, { type: 'commit', head });
  const byPath = new Map(diff.files.map((file) => [file.path, file]));
  expect([...byPath.keys()].sort()).toEqual([
    'added.txt',
    'blob.bin',
    'gone.txt',
    'mode.txt',
    'moved.txt',
    'renamed.txt',
  ]);

  expect(byPath.get('added.txt')?.status).toBe('added');
  expect(byPath.get('added.txt')?.additions).toBe(2);

  expect(byPath.get('gone.txt')?.status).toBe('deleted');
  expect(byPath.get('gone.txt')?.deletions).toBe(2);
  expect(byPath.get('gone.txt')?.hunks[0]?.id).toBe('gone.txt:h1');

  const renamed = byPath.get('renamed.txt');
  expect(renamed?.status).toBe('renamed');
  expect(renamed?.oldPath).toBe('torename.txt');
  expect(renamed?.hunks).toEqual([]);
  expect(renamed?.additions).toBe(0);
  expect(renamed?.deletions).toBe(0);

  const moved = byPath.get('moved.txt');
  expect(moved?.status).toBe('renamed');
  expect(moved?.oldPath).toBe('seed.txt');
  expect(moved?.hunks[0]?.id).toBe('moved.txt:h1');
  expect(moved?.additions).toBe(1);
  expect(moved?.deletions).toBe(1);

  const binary = byPath.get('blob.bin');
  expect(binary?.binary).toBe(true);
  expect(binary?.status).toBe('modified');
  expect(binary?.additions).toBe(0);
  expect(binary?.deletions).toBe(0);
  expect(binary?.hunks).toEqual([
    {
      id: 'blob.bin:h1',
      n: 1,
      header: '',
      oldStart: 0,
      oldLines: 0,
      newStart: 0,
      newLines: 0,
      additions: 0,
      deletions: 0,
      text: '',
    },
  ]);

  const mode = byPath.get('mode.txt');
  expect(mode?.status).toBe('modified');
  expect(mode?.binary).toBe(false);
  expect(mode?.hunks).toEqual([]);
});

test('no newline at end of file is preserved verbatim in the hunk text', async () => {
  const repo = makeRepo();
  repo.write('nonl.txt', 'first');
  repo.commit('base');
  repo.write('nonl.txt', 'second');

  const diff = await computeDiff(repo.root, { type: 'working-tree' });
  const hunk = diff.files[0]?.hunks[0];

  expect(hunk?.text).toBe(
    '@@ -1 +1 @@\n-first\n\\ No newline at end of file\n+second\n\\ No newline at end of file\n',
  );
  expect(diff.files[0]?.additions).toBe(1);
  expect(diff.files[0]?.deletions).toBe(1);
});

test('paths with spaces and non-ASCII survive the round trip', async () => {
  const repo = makeRepo();
  repo.write('my dir/space file.txt', 'a\nb\nc\n');
  repo.write('café notes.md', '# héllo\n');
  repo.commit('base');
  repo.write('my dir/space file.txt', 'a\nB\nc\n');
  repo.write('café notes.md', '# héllo world\n');

  const diff = await computeDiff(repo.root, { type: 'working-tree' });

  expect(diff.files.map((file) => file.path).sort()).toEqual([
    'café notes.md',
    'my dir/space file.txt',
  ]);
  const spaced = diff.files.find((file) => file.path === 'my dir/space file.txt');
  expect(spaced?.hunks[0]?.id).toBe('my dir/space file.txt:h1');
  expect(spaced?.additions).toBe(1);
});

test('a repo with no commits diffs the index against the empty tree', async () => {
  const repo = makeRepo();
  repo.write('a.txt', 'staged\n');
  repo.git('add', 'a.txt');
  repo.write('untracked.txt', 'invisible\n');

  const worktree = await computeDiff(repo.root, { type: 'working-tree' });
  expect(worktree.headSha).toBeNull();
  expect(worktree.files.map((file) => file.path)).toEqual(['a.txt']);
  expect(worktree.files[0]?.status).toBe('added');

  const staged = await computeDiff(repo.root, { type: 'staged' });
  expect(staged.headSha).toBeNull();
  expect(staged.files.map((file) => file.path)).toEqual(['a.txt']);
});

test('an unresolvable ref or a missing source field is an error, not an empty diff', async () => {
  const repo = makeRepo();
  repo.write('a.txt', 'a\n');
  repo.commit('base');

  await expect(computeDiff(repo.root, { type: 'commit', head: 'nosuchref' })).rejects.toThrow(
    /cannot resolve commit/,
  );
  await expect(computeDiff(repo.root, { type: 'commit' })).rejects.toThrow(/source.head/);
  await expect(computeDiff(repo.root, { type: 'range', head: 'HEAD' })).rejects.toThrow(
    /source.base/,
  );
  await expect(computeDiff(repo.root, { type: 'range', base: '-x', head: 'HEAD' })).rejects.toThrow(
    /must not start with/,
  );
  await expect(
    computeDiff(repo.root, { type: 'range', base: 'nosuch', head: 'HEAD' }),
  ).rejects.toThrow(GitError);
});

test('showFile returns raw bytes at a ref', async () => {
  const repo = makeRepo();
  repo.write('src/a.ts', 'export const a = 1;\n');
  repo.write('blob.bin', new Uint8Array([0, 1, 2, 250, 255]));
  const head = repo.commit('base');
  repo.write('src/a.ts', 'export const a = 2;\n');

  const atHead = await showFile(repo.root, head, 'src/a.ts');
  expect(atHead).not.toBeNull();
  expect(new TextDecoder().decode(atHead ?? new Uint8Array())).toBe('export const a = 1;\n');

  const bytes = await showFile(repo.root, 'HEAD', 'blob.bin');
  expect([...(bytes ?? [])]).toEqual([0, 1, 2, 250, 255]);
});

test('showFile returns null for a missing path, a working-tree-only path, or a bad ref', async () => {
  const repo = makeRepo();
  repo.write('a.txt', 'a\n');
  repo.commit('base');
  repo.write('only-on-disk.txt', 'not committed\n');

  await expect(showFile(repo.root, 'HEAD', 'nope.txt')).resolves.toBeNull();
  await expect(showFile(repo.root, 'HEAD', 'only-on-disk.txt')).resolves.toBeNull();
  await expect(showFile(repo.root, 'nosuchref', 'a.txt')).resolves.toBeNull();
});

test('a real git failure throws instead of returning an empty result', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'vsdiff-nogit-'));
  tempRoots.push(outside);

  await expect(showFile(outside, 'HEAD', 'a.txt')).rejects.toThrow(GitError);
  await expect(computeDiff(outside, { type: 'working-tree' })).rejects.toThrow(GitError);
});

test('a hostile diff config in the environment cannot corrupt paths', async () => {
  const repo = makeRepo();
  repo.write('sub/f.txt', 'a\nb\nc\n');
  repo.commit('base');
  repo.write('sub/f.txt', 'a\nB\nc\n');
  const config = join(repo.root, 'hostile.gitconfig');
  writeFileSync(
    config,
    '[diff]\n\tnoprefix = true\n\tmnemonicPrefix = true\n\trelative = true\n\tsrcPrefix = "OLD/"\n\tdstPrefix = "NEW/"\n',
  );

  const previous = process.env['GIT_CONFIG_GLOBAL'];
  process.env['GIT_CONFIG_GLOBAL'] = config;
  try {
    const diff = await computeDiff(repo.root, { type: 'working-tree' });
    expect(diff.files.map((file) => file.path)).toEqual(['sub/f.txt']);
    expect(diff.files[0]?.hunks[0]?.id).toBe('sub/f.txt:h1');
  } finally {
    if (previous === undefined) delete process.env['GIT_CONFIG_GLOBAL'];
    else process.env['GIT_CONFIG_GLOBAL'] = previous;
  }
});

test('diffstat sums files, hunks and line counts', async () => {
  const repo = makeRepo();
  repo.write('multi.ts', lines(30));
  repo.write('gone.txt', 'x\n');
  repo.write('blob.bin', new Uint8Array([0, 1, 2]));
  repo.commit('base');
  repo.write(
    'multi.ts',
    lines(30).replace('line2\n', 'line2 changed\n').replace('line25\n', 'line25 changed\n'),
  );
  rmSync(join(repo.root, 'gone.txt'));
  repo.write('blob.bin', new Uint8Array([3, 4, 5, 6]));
  repo.write('added.txt', 'one\ntwo\n');
  repo.git('add', '-A');

  const diff = await computeDiff(repo.root, { type: 'working-tree' });

  expect(diffstat(diff)).toEqual({
    // multi.ts (2) + blob.bin (1 synthetic) + gone.txt (1) + added.txt (1)
    files: 4,
    hunks: 5,
    additions: 4,
    deletions: 3,
  });
});
