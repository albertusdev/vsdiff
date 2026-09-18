import { expect, test } from '@playwright/test';
import { FIXTURE_L, exec, fetchState, openWorkbench, shot, waitForBridge } from './helpers.ts';

// Guided review over the L fixture (~120 files / ~12k changed LOC): the P1
// exit test, including the R9 perf budgets. The golden session lives inside
// the fixture repo at .vsdiff/sessions/2026-01-02-payments-refactor/.

const LOAD_BUDGET_MS = 300;
const NAV_BUDGET_MS = 150;

test('L fixture: session loads within budget and the outline renders', async ({ page }) => {
  await openWorkbench(page, FIXTURE_L);
  const bridge = await waitForBridge(FIXTURE_L);

  // Session state settles right after activation; poll briefly.
  let state = await fetchState(bridge);
  const deadline = Date.now() + 30_000;
  while (state.session.phase !== 'loaded' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    state = await fetchState(bridge);
  }

  expect(state.session.phase).toBe('loaded');
  expect(state.session.title).toBe('Payments refactor');
  expect(state.session.stops).toBe(8);
  expect(state.session.stats?.staleStops).toBe(0);
  expect(state.session.stats?.missingRefs).toBe(0);
  expect(state.perf.loadMs).toBeDefined();
  expect(state.perf.loadMs!).toBeLessThan(LOAD_BUDGET_MS);

  // Browser reviews now open the outline automatically; focus is idempotent.
  await exec(bridge, 'vsdiff.outline.focus');
  await expect(page.getByText('Capture', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Not covered by the session')).toBeVisible();
  await page.screenshot({ path: shot('10-l-outline.png') });
});

test('L fixture: guided traversal opens diffs within budget', async ({ page }) => {
  await openWorkbench(page, FIXTURE_L);
  const bridge = await waitForBridge(FIXTURE_L);

  await exec(bridge, 'vsdiff.openStop', [0]);
  await expect(page.locator('.monaco-diff-editor').first()).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: shot('11-l-stop1-diff.png') });

  await exec(bridge, 'vsdiff.nextStop');
  await exec(bridge, 'vsdiff.nextStop');
  const state = await fetchState(bridge);
  expect(state.session.currentIndex).toBe(2);
  await test.info().attach('navigation-timing.json', {
    body: JSON.stringify(state.perf),
    contentType: 'application/json',
  });
  expect(state.perf.lastNavMs).toBeDefined();
  expect(state.perf.lastNavMs!).toBeLessThan(NAV_BUDGET_MS);
  await page.screenshot({ path: shot('12-l-stop3-diff.png') });

  // Jumping straight to the docs-drift finding lands on a markdown diff.
  await exec(bridge, 'vsdiff.openStop', [6]);
  const after = await fetchState(bridge);
  expect(after.session.currentIndex).toBe(6);
  await page.screenshot({ path: shot('13-l-docs-finding.png') });
});

test('L fixture: multi-hunk stop cycles across files', async ({ page }) => {
  await openWorkbench(page, FIXTURE_L);
  const bridge = await waitForBridge(FIXTURE_L);

  // Stop 2 (retry-guard) = capture.ts:h2 + client.ts:h1 — one idea, two files.
  await exec(bridge, 'vsdiff.openStop', [1]);
  let state = (await fetchState(bridge)) as unknown as {
    hunk: { hunkOrdinal: number; hunkCount: number };
  };
  expect(state.hunk).toEqual({ hunkOrdinal: 0, hunkCount: 2 });
  await expect(page.locator('.tab.active', { hasText: 'capture.ts' }).first()).toBeVisible({
    timeout: 15_000,
  });

  await exec(bridge, 'vsdiff.nextHunk');
  state = (await fetchState(bridge)) as unknown as {
    hunk: { hunkOrdinal: number; hunkCount: number };
  };
  expect(state.hunk).toEqual({ hunkOrdinal: 1, hunkCount: 2 });
  await expect(page.locator('.tab.active', { hasText: 'client.ts' }).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.screenshot({ path: shot('14-l-hunk-cycle.png') });

  // Wraps back to the first hunk.
  await exec(bridge, 'vsdiff.nextHunk');
  state = (await fetchState(bridge)) as unknown as {
    hunk: { hunkOrdinal: number; hunkCount: number };
  };
  expect(state.hunk.hunkOrdinal).toBe(0);
});
