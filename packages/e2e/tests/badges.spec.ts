import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { FIXTURE_L, exec, openWorkbench, shot, waitForBridge } from './helpers.ts';

// Stop metadata as SVG label chips instead of an italic line (dogfood feedback).
// Comment bodies are MarkdownString — no HTML — so each chip is an inline SVG
// behind a `data:image/svg+xml` markdown image. This spec is the proof that the
// workbench markdown sanitizer keeps those sources: they only reach the DOM as
// <img> if nothing stripped them. Comment widgets render into the workbench DOM
// directly, unlike webviews, so no frame hop is needed. The `:visible` filter
// matters — the same editor also hosts the collapsed threads of other stops.

const SESSION_DIR = join(FIXTURE_L, '.vsdiff', 'sessions', '2026-01-02-payments-refactor');
const CHIP = '.review-widget .comment-body img';

test.beforeAll(() => {
  rmSync(join(SESSION_DIR, 'feedback.jsonl'), { force: true });
  rmSync(join(SESSION_DIR, 'result.json'), { force: true });
});

test('stop metadata renders as SVG label chips in the comment body', async ({ page }) => {
  await openWorkbench(page, FIXTURE_L);
  const bridge = await waitForBridge(FIXTURE_L);

  await exec(bridge, 'vsdiff.reload');
  await exec(bridge, 'vsdiff.openStop', [0]);
  await expect(page.locator('.monaco-diff-editor').first()).toBeVisible({ timeout: 20_000 });

  // The current stop's prose thread is the expanded zone widget over its hunk.
  await expect(page.getByText('vsdiff · agent guide').first()).toBeVisible({ timeout: 20_000 });

  const chips = page.locator(`${CHIP}[src^="data:image/svg"]:visible`);
  await expect(chips.first()).toBeVisible({ timeout: 20_000 });

  // Stop 1 of the golden session is a walkthrough with no severity: one kind
  // chip and one position chip. Alt text is the label, so a chip that never
  // paints still reads as the word it stands for.
  expect(await chips.count()).toBeGreaterThanOrEqual(2);
  await expect(page.locator(`${CHIP}[alt="walkthrough"]:visible`).first()).toBeVisible();
  await expect(page.locator(`${CHIP}[alt^="stop "]:visible`).first()).toBeVisible();

  // The src survives as a real SVG document, not stripped or rewritten.
  const src = await chips.first().getAttribute('src');
  expect(decodeURIComponent(src ?? '')).toContain('<svg xmlns="http://www.w3.org/2000/svg"');

  // …and the browser decoded it: a blocked or malformed data URI would paint
  // as a zero-width broken image. (The specs run without the DOM lib, hence
  // the structural cast.)
  await expect
    .poll(
      () =>
        chips.first().evaluate((img) => (img as unknown as { naturalWidth: number }).naturalWidth),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);

  // The Comments panel opens itself over the diff; close it so the shot shows
  // the chips in the thread, not the index of them.
  await exec(bridge, 'workbench.action.closePanel');
  await page.screenshot({ path: shot('72-badges.png') });
});
