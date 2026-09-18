import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { FIXTURE_L, exec, fetchState, openWorkbench, shot, waitForBridge } from './helpers.ts';

// The Review Overview: auto-opens once per session, renders green/red LOC,
// section links drive the same navigation as the sidebar, and stops/chapters
// carry done-checkmarks persisted as stop-done events.

let folder: string;
let sessionDir: string;

interface OverviewShape {
  overview: { open: boolean };
  feedback: { done: string[] };
  session: { currentIndex?: number };
}

test.beforeAll(() => {
  // Auto-open is once per session; use a new workspace rather than a reused
  // extension host whose Overview may already have been intentionally hidden.
  folder = mkdtempSync(join(FIXTURE_L, '..', 'overview-'));
  cpSync(FIXTURE_L, folder, { recursive: true });
  sessionDir = join(folder, '.vsdiff', 'sessions', '2026-01-02-payments-refactor');
  rmSync(join(sessionDir, 'feedback.jsonl'), { force: true });
  rmSync(join(sessionDir, 'result.json'), { force: true });
});

test.afterAll(() => rmSync(folder, { recursive: true, force: true }));

test('overview auto-opens, links navigate, checkmarks persist', async ({ page }) => {
  await openWorkbench(page, folder);
  const bridge = await waitForBridge(folder);
  await exec(bridge, 'vsdiff.reload');

  // Auto-open on session load — no command needed.
  const deadline = Date.now() + 20_000;
  let state = (await fetchState(bridge)) as unknown as OverviewShape;
  while (!state.overview.open && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    state = (await fetchState(bridge)) as unknown as OverviewShape;
  }
  expect(state.overview.open).toBe(true);

  // The webview renders inside nested iframes; find our content.
  const frame = page.frameLocator('iframe.webview').last().frameLocator('#active-frame');
  await expect(frame.getByText('Payments refactor').first()).toBeVisible({ timeout: 20_000 });
  // Green/red LOC rendered (the thing native trees cannot do).
  await expect(frame.locator('.add').first()).toBeVisible();
  await expect(frame.locator('.del').first()).toBeVisible();
  await page.screenshot({ path: shot('70-overview.png') });

  // Clicking a stop title behaves exactly like the sidebar (async command —
  // poll rather than read-once; caught by the icons coder's run).
  await frame.getByText('Client retry budget', { exact: true }).click();
  const navDeadline = Date.now() + 15_000;
  let after = (await fetchState(bridge)) as unknown as OverviewShape;
  while (after.session.currentIndex !== 5 && Date.now() < navDeadline) {
    await new Promise((r) => setTimeout(r, 400));
    after = (await fetchState(bridge)) as unknown as OverviewShape;
  }
  expect(after.session.currentIndex).toBe(5);

  // The diff we just opened buried the overview tab; re-reveal it (the panel
  // re-pushes state on visibility — that path is part of what this asserts).
  await exec(bridge, 'vsdiff.openOverview');
  await expect(frame.getByText('Payments refactor').first()).toBeVisible({ timeout: 20_000 });

  // Done-checkmark → stop-done event → folded state → tree mirrors it.
  // autoDone may have checked the navigated stop already; retry the click if a
  // repaint burst eats it (same residual race the tree specs guard against).
  const firstCheckbox = frame.locator('.stop .done-check').first();
  let done = (await fetchState(bridge)) as unknown as OverviewShape;
  for (let attempt = 0; attempt < 3 && !done.feedback.done.includes('pipeline'); attempt++) {
    await firstCheckbox.click();
    const deadline2 = Date.now() + 6_000;
    while (!done.feedback.done.includes('pipeline') && Date.now() < deadline2) {
      await new Promise((r) => setTimeout(r, 400));
      done = (await fetchState(bridge)) as unknown as OverviewShape;
    }
  }
  expect(done.feedback.done).toContain('pipeline');
  await page.screenshot({ path: shot('71-overview-done.png') });
});
