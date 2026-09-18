import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createDemo } from '../../../scripts/demo-fixture.mjs';
import { ROOT, exec, openWorkbench, waitForBridge } from './helpers.ts';

// Real editor footage. Only run on request; it writes public documentation assets.
test.skip(process.env.VSDIFF_MEDIA !== '1', 'media generation is opt-in');
test.use({ video: { mode: 'on', size: { width: 1440, height: 900 } } });

test('capture README screenshots and the demo recording', async ({ page }) => {
  const media = join(ROOT, 'docs/media');
  const raw = join(ROOT, '.dev/launch');
  mkdirSync(media, { recursive: true });
  mkdirSync(raw, { recursive: true });
  const start = Date.now();
  const marks: Array<{ at: number; text: string }> = [];
  const mark = (text: string) => marks.push({ at: (Date.now() - start) / 1000, text });
  const { folder } = await createDemo();
  await openWorkbench(page, folder);
  const bridge = await waitForBridge(folder);
  await exec(bridge, 'vsdiff.openOverview');
  const overview = page.frameLocator('iframe.webview').last().frameLocator('#active-frame');
  await expect(overview.getByText('Retry payments safely', { exact: true })).toBeVisible();
  const banner = page.getByRole('button', { name: 'Close Banner', exact: true });
  if (await banner.isVisible()) await banner.click();
  // Establish the same readable layout used throughout the recording.
  await exec(bridge, 'vsdiff.focusReview');
  await page.waitForTimeout(700);
  mark('Start with the review map.');
  await page.screenshot({ path: join(media, 'overview.png') });
  await page.waitForTimeout(2400);
  await overview.getByText('Keep the payment key', { exact: true }).click();
  const guide = page.locator('.review-widget').filter({ hasText: 'vsdiff · agent guide' }).first();
  await expect(guide).toBeVisible();
  mark('Follow the explanation into a real diff.');
  await page.waitForTimeout(2000);
  await guide.getByRole('button', { name: 'Show full guide', exact: true }).click();
  await page.waitForTimeout(2200);
  await guide.getByRole('button', { name: 'Show less', exact: true }).click();
  await guide.locator('.review-thread-reply-button').click();
  mark('Ask a question beside the code.');
  const input = page.getByRole('textbox', { name: 'Editor content', exact: true });
  await input.pressSequentially('Please add a test for an empty payment key.', { delay: 45 });
  await page.waitForTimeout(700);
  await input.press('Control+Enter');
  await expect(
    page.getByRole('treeitem').filter({ hasText: 'Please add a test for an empty payment key.' }),
  ).toBeVisible();
  await page.waitForTimeout(2400);
  await page.screenshot({ path: join(media, 'guided-walk.png') });
  await exec(bridge, 'vsdiff.openOverview');
  await overview.getByRole('button', { name: 'Pin Overview', exact: true }).click();
  await expect(overview.getByRole('button', { name: 'Unpin Overview', exact: true })).toBeVisible();
  await overview.getByText('Retry temporary errors', { exact: true }).click();
  mark('Keep the map beside you when it helps.');
  await page.waitForTimeout(2800);
  await page.screenshot({ path: join(media, 'pinned-overview.png') });
  await overview.getByRole('button', { name: 'Unpin Overview', exact: true }).click();
  await overview.getByText('Test the retry', { exact: true }).click();
  mark('Review the proof, then send your decision.');
  await page.waitForTimeout(2400);
  await page.screenshot({ path: join(media, 'outline.png') });
  const finished = exec(bridge, 'vsdiff.finishReview');
  await page.getByRole('option', { name: /Request changes/ }).click();
  await finished;
  mark('Your feedback is ready for the agent.');
  await page.waitForTimeout(2500);
  const end = (Date.now() - start) / 1000;
  writeFileSync(
    join(raw, 'demo-timeline.json'),
    JSON.stringify({ start: marks[0]!.at, end, marks }, null, 2),
  );
  const video = page.video();
  await page.close();
  await video!.saveAs(join(raw, 'demo.webm'));
});
