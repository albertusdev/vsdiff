import { expect, test } from '@playwright/test';
import { FIXTURE_S, exec, fetchState, openWorkbench, shot, waitForBridge } from './helpers.ts';

// The S fixture has no session — this suite covers the empty state and the
// bridge plumbing. Guided review is covered by l-fixture.spec.ts.

test('workbench loads; vsdiff shows its empty state', async ({ page }) => {
  await openWorkbench(page, FIXTURE_S);
  await waitForBridge(FIXTURE_S);
  await page.screenshot({ path: shot('01-workbench.png') });

  const activityIcon = page.locator('.activitybar [aria-label*="vsdiff" i]').first();
  await expect(activityIcon).toBeVisible({ timeout: 30_000 });
  await activityIcon.click();

  // viewsWelcome empty state
  await expect(page.getByText('No review session loaded')).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: shot('02-empty-state.png') });
});

test('dev bridge reports state and executes commands', async ({ page }) => {
  await openWorkbench(page, FIXTURE_S);
  const bridge = await waitForBridge(FIXTURE_S);

  const state = await fetchState(bridge);
  expect(state.extension.id).toBe('vsdiff.vsdiff');
  expect(state.session.phase).toBe('none');
  expect(state.workspaceFolders[0]).toContain('s-repo');

  const result = (await exec(bridge, 'vsdiff.hello')) as string;
  expect(result).toMatch(/vsdiff \d+\.\d+\.\d+/); // version-agnostic: bumps must not break smoke
});
