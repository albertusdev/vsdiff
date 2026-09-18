import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { containedFile, isRelativeFilePath } from './safe-path.ts';

test('rejects traversal, URLs, Windows paths and control characters', () => {
  for (const path of [
    '../secret',
    'guide/../../secret',
    '/etc/passwd',
    'C:\\secret',
    '\\\\host\\secret',
    'file:///secret',
    'guide\u0000.html',
    '..\\secret',
  ])
    expect(isRelativeFilePath(path)).toBe(false);
  expect(isRelativeFilePath('guide/index.html')).toBe(true);
});

test('resolves real files while rejecting symlink escapes from the permitted root', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vsdiff-path-security-'));
  try {
    const root = join(dir, 'session');
    await mkdir(root);
    await writeFile(join(root, 'guide.html'), '<p>guide</p>');
    await writeFile(join(dir, 'outside.html'), 'private');
    await symlink(join(dir, 'outside.html'), join(root, 'escape.html'));
    expect(await containedFile(root, 'guide.html')).toBe(join(root, 'guide.html'));
    expect(await containedFile(root, '../outside.html')).toBeUndefined();
    expect(await containedFile(root, 'escape.html')).toBeUndefined();
    expect(await containedFile(root, 'missing.html')).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
