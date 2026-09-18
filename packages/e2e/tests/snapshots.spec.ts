import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createDemo } from '../../../scripts/demo-fixture.mjs';
import { exec, openWorkbench, waitForBridge } from './helpers.ts';

test('range, commit, and staged reviews show their selected content despite checkout edits', async ({
  page,
}) => {
  const { folder, sessionDir } = await createDemo();
  const sessionFile = join(sessionDir, 'session.json');
  const session = JSON.parse(readFileSync(sessionFile, 'utf8'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: folder, encoding: 'utf8' }).trim();
  // Move the base branch after the fork; neither this change nor checkout
  // content belongs in the review's selected pair of snapshots.
  git('switch', 'main');
  writeFileSync(join(folder, 'src/payments.ts'), 'BASE_BRANCH_MOVED\n');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-am',
    'Base moves',
  );
  session.source.base = 'main';
  writeFileSync(sessionFile, JSON.stringify(session));
  git('switch', 'retry-payments');
  writeFileSync(join(folder, 'src/payments.ts'), 'UNSTAGED_SENTINEL\n');
  await openWorkbench(page, folder);
  const bridge = await waitForBridge(folder);
  for (const source of [session.source, { type: 'commit', head: session.source.head }]) {
    session.source = source;
    writeFileSync(sessionFile, JSON.stringify(session));
    await exec(bridge, 'vsdiff.reload');
    await exec(bridge, 'vsdiff.openStop', [0]);
    const diff = page.locator('.monaco-diff-editor').first();
    await expect(diff).toContainText('idempotencyKey:');
    await expect(diff).not.toContainText('UNSTAGED_SENTINEL');
    await expect(diff).not.toContainText('BASE_BRANCH_MOVED');
  }
  writeFileSync(join(folder, 'src/payments.ts'), 'STAGED_SENTINEL\n');
  git('add', 'src/payments.ts');
  writeFileSync(join(folder, 'src/payments.ts'), 'UNSTAGED_SENTINEL\n');
  session.source = { type: 'staged' };
  writeFileSync(sessionFile, JSON.stringify(session));
  await exec(bridge, 'vsdiff.reload');
  await exec(bridge, 'vsdiff.openStop', [0]);
  const diff = page.locator('.monaco-diff-editor').first();
  await expect(diff).toContainText('STAGED_SENTINEL');
  await expect(diff).not.toContainText('UNSTAGED_SENTINEL');
  writeFileSync(join(folder, 'src/payments.ts'), 'UPDATED_INDEX_SENTINEL\n');
  git('add', 'src/payments.ts');
  await exec(bridge, 'vsdiff.reload');
  await exec(bridge, 'vsdiff.openStop', [0]);
  await expect(diff).toContainText('UPDATED_INDEX_SENTINEL');
});
