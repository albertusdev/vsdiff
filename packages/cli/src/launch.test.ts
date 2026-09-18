import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { findOnPath, launchDisabled, launchEditor } from './launch.ts';

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.length = 0;
});

function makeBinDir(names: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'vsdiff-cli-launch-'));
  tempRoots.push(root);
  for (const name of names) {
    const file = join(root, name);
    writeFileSync(file, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(file, 0o755);
  }
  return root;
}

test('VSDIFF_NO_LAUNCH turns the editor launch off', () => {
  expect(launchDisabled({ VSDIFF_NO_LAUNCH: '1' })).toBe(true);
  expect(launchDisabled({ VSDIFF_NO_LAUNCH: 'yes' })).toBe(true);
  expect(launchDisabled({})).toBe(false);
  expect(launchDisabled({ VSDIFF_NO_LAUNCH: '' })).toBe(false);
  expect(launchDisabled({ VSDIFF_NO_LAUNCH: '0' })).toBe(false);
});

test('findOnPath returns the first executable and skips empty entries', () => {
  const first = makeBinDir([]);
  const second = makeBinDir(['code']);
  const third = makeBinDir(['code']);
  const PATH = ['', first, second, third].join(delimiter);

  expect(findOnPath('code', { PATH })).toBe(join(second, 'code'));
  expect(findOnPath('cursor', { PATH })).toBeNull();
  expect(findOnPath('code', {})).toBeNull();
});

test('a non-executable file is not a launchable editor', () => {
  const dir = makeBinDir([]);
  writeFileSync(join(dir, 'code'), 'not executable\n', 'utf8');
  chmodSync(join(dir, 'code'), 0o644);

  expect(findOnPath('code', { PATH: dir })).toBeNull();
});

test('launchEditor spawns nothing when disabled or when no editor exists', async () => {
  const empty = makeBinDir([]);
  // HOME/XDG point at an empty dir so the real global config never leaks in.
  const base = { HOME: empty, XDG_CONFIG_HOME: empty };
  await expect(
    launchEditor(empty, { ...base, VSDIFF_NO_LAUNCH: '1', PATH: makeBinDir(['code']) }),
  ).resolves.toBeNull();
  await expect(launchEditor(empty, { ...base, PATH: empty })).resolves.toBeNull();
});
