import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import type { BridgeInfo } from './helpers.ts';
import { FIXTURE_L, exec, fetchState, openWorkbench, shot, waitForBridge } from './helpers.ts';

// Round-5 polish: the outline gains GitHub-PR-style granularity — native
// done-checkboxes on chapter/stop rows, and file children under multi-hunk
// stops with colored A/M/D/R status decorations that jump to that file's hunk.

const SESSION_DIR = join(FIXTURE_L, '.vsdiff', 'sessions', '2026-01-02-payments-refactor');

interface OutlineShape {
  outline: string[];
  session: { currentIndex?: number };
  feedback: { done: string[]; doneFiles?: Record<string, string[]> };
}

/** Bridge state is eventually consistent (file watcher → fold → tree). */
async function pollState(
  bridge: BridgeInfo,
  ok: (state: OutlineShape) => boolean,
  timeoutMs = 20_000,
): Promise<OutlineShape> {
  const deadline = Date.now() + timeoutMs;
  let state = (await fetchState(bridge)) as unknown as OutlineShape;
  while (!ok(state) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    state = (await fetchState(bridge)) as unknown as OutlineShape;
  }
  return state;
}

test.beforeAll(() => {
  rmSync(join(SESSION_DIR, 'feedback.jsonl'), { force: true });
  rmSync(join(SESSION_DIR, 'result.json'), { force: true });
});

/** Clicks a tree checkbox until its event lands. A feedback-refresh burst can
 *  re-render the row between hit-test and toggle, eating the click — the tree
 *  refresh is debounced product-side, this retries the residual race. The
 *  first wait is generous so a slow-but-landed click is never double-toggled. */
async function tickUntil(
  box: Locator,
  bridge: BridgeInfo,
  holds: (state: OutlineShape) => boolean,
): Promise<OutlineShape> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await box.click();
    const state = await pollState(bridge, holds, attempt === 0 ? 8_000 : 5_000);
    if (holds(state)) return state;
  }
  throw new Error('checkbox click never produced the expected feedback event');
}

test('outline: file children, status decorations, done checkboxes', async ({ page }) => {
  await openWorkbench(page, FIXTURE_L);
  const bridge = await waitForBridge(FIXTURE_L);
  await exec(bridge, 'vsdiff.reload');

  // The retry-guard stop (index 1) spans client.ts + capture.ts: its file rows
  // are in the snapshot's third level.
  const deadline = Date.now() + 20_000;
  let state = (await fetchState(bridge)) as unknown as OutlineShape;
  while (!state.outline?.includes('client.ts') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    state = (await fetchState(bridge)) as unknown as OutlineShape;
  }
  expect(state.outline).toContain('client.ts');
  expect(state.outline).toContain('capture.ts');

  // A file row jumps to ITS hunk of the stop: expand the multi-file stop in
  // the real tree and click the second file. The workbench starts on the
  // Explorer — surface the vsdiff view first.
  await exec(bridge, 'vsdiff.outline.focus');
  const outlinePane = page.locator('.pane', { hasText: 'Review Outline' }).first();
  const stopRow = outlinePane.locator('.monaco-list-row', {
    hasText: 'Double-charge guard lost on retry',
  });
  await expect(stopRow).toBeVisible({ timeout: 20_000 });
  await stopRow.locator('.monaco-tl-twistie').click();
  const fileRow = outlinePane.locator('.monaco-list-row', { hasText: 'capture.ts' }).first();
  await expect(fileRow).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: shot('76-outline-files.png') });
  await fileRow.click();
  const navDeadline = Date.now() + 15_000;
  let after = (await fetchState(bridge)) as unknown as OutlineShape;
  while (after.session.currentIndex !== 1 && Date.now() < navDeadline) {
    await new Promise((r) => setTimeout(r, 400));
    after = (await fetchState(bridge)) as unknown as OutlineShape;
  }
  expect(after.session.currentIndex).toBe(1);

  // The native checkbox on a stop row records a stop-done event.
  const pipelineRow = outlinePane.locator('.monaco-list-row', {
    hasText: 'New capture pipeline',
  });
  await expect(pipelineRow).toBeVisible({ timeout: 15_000 });
  const done = await tickUntil(
    pipelineRow.locator('input[type="checkbox"], .monaco-checkbox').first(),
    bridge,
    (s) => s.feedback.done.includes('pipeline'),
  );
  expect(done.feedback.done).toContain('pipeline');

  // R18 parity: the same event is reachable headlessly.
  await exec(bridge, 'vsdiff.markStopDone', ['token-rename', true]);
  const parityDeadline = Date.now() + 15_000;
  let parity = (await fetchState(bridge)) as unknown as OutlineShape;
  while (!parity.feedback.done.includes('token-rename') && Date.now() < parityDeadline) {
    await new Promise((r) => setTimeout(r, 400));
    parity = (await fetchState(bridge)) as unknown as OutlineShape;
  }
  expect(parity.feedback.done).toContain('token-rename');
  await page.screenshot({ path: shot('77-outline-done.png') });
});

// Round-6: per-file done-checkboxes that roll up into the stop, and the
// by-file pivot — the same change read backwards, file → the stops that own it.
// The feedback log is NOT reset between tests (beforeAll clears it once): the
// test above marks `pipeline` and `token-rename` done, this one only touches
// `retry-guard`.
test('outline: file checkboxes roll up, Files pivot maps files to stops', async ({ page }) => {
  // Fresh log: test 1's navigations auto-mark files/stops (autoDone), which
  // would preload the checkbox states this test asserts from zero.
  rmSync(join(SESSION_DIR, 'feedback.jsonl'), { force: true });
  await openWorkbench(page, FIXTURE_L);
  const bridge = await waitForBridge(FIXTURE_L);
  await exec(bridge, 'vsdiff.reload');

  const loaded = await pollState(bridge, (s) => s.outline?.includes('Files') ?? false);
  expect(loaded.outline).toContain('Files');
  // The pivot's third level: every stop that touches a given file. client.ts is
  // owned by retry-guard (index 1) AND retry-budget (index 5).
  expect(loaded.outline).toContain('Client retry budget');

  await exec(bridge, 'vsdiff.outline.focus');
  const outlinePane = page.locator('.pane', { hasText: 'Review Outline' }).first();
  // Match the row LABEL exactly: 'Capture' the chapter must not also select
  // 'New capture pipeline', and 'client.ts' must not select a description.
  const row = (label: string) =>
    outlinePane.locator('.monaco-list-row').filter({
      has: page.locator('.label-name, .monaco-highlighted-label', {
        hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
      }),
    });
  const checkbox = (label: string) =>
    row(label).first().locator('input[type="checkbox"], .monaco-checkbox').first();

  // ---- file checkboxes roll up into the stop ------------------------------
  const stopRow = row('Double-charge guard lost on retry').first();
  await expect(stopRow).toBeVisible({ timeout: 20_000 });
  await stopRow.locator('.monaco-tl-twistie').click();
  await expect(row('capture.ts').first()).toBeVisible({ timeout: 15_000 });

  const oneFile = await tickUntil(checkbox('capture.ts'), bridge, (s) =>
    (s.feedback.doneFiles?.['retry-guard'] ?? []).includes('src/payments/capture.ts'),
  );
  expect(oneFile.feedback.doneFiles?.['retry-guard']).toContain('src/payments/capture.ts');
  expect(oneFile.feedback.done).not.toContain('retry-guard');

  // The second (last) file of the stop completes it: the writer appends the
  // plain stop-done event too.
  const rolled = await tickUntil(checkbox('client.ts'), bridge, (s) =>
    s.feedback.done.includes('retry-guard'),
  );
  expect(rolled.feedback.done).toContain('retry-guard');

  // ---- the by-file pivot ---------------------------------------------------
  // Collapse the chapters so the Files root and its children fit the viewport
  // (the tree virtualises: an off-screen row is not in the DOM at all) and so
  // 'client.ts' names exactly one row — the pivot's.
  for (const chapter of ['Capture', 'Auth', 'API']) {
    await row(chapter).first().locator('.monaco-tl-twistie').click();
  }
  const filesRoot = row('Files').first();
  await expect(filesRoot).toBeVisible({ timeout: 15_000 });
  await filesRoot.locator('.monaco-tl-twistie').click();

  const pivotFile = row('client.ts').first();
  await expect(pivotFile).toBeVisible({ timeout: 15_000 });
  await pivotFile.locator('.monaco-tl-twistie').click();
  await expect(row('Double-charge guard lost on retry').first()).toBeVisible({ timeout: 15_000 });
  const budgetRow = row('Client retry budget').first();
  await expect(budgetRow).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: shot('79-files-pivot.png') });

  // A pivot row jumps to that stop (index 5) at this file's hunk.
  await budgetRow.click();
  const navigated = await pollState(bridge, (s) => s.session.currentIndex === 5);
  expect(navigated.session.currentIndex).toBe(5);
});
