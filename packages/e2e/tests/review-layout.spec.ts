import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { FIXTURE_L, exec, openWorkbench, shot, waitForBridge } from './helpers.ts';

let folder: string;
let feedbackFile: string;
const ending = 'Keep this final explanation available when the guide expands.';
const prose =
  'Start with the retry guard before changing the capture flow.\n\n' +
  'This longer explanation gives the reviewer context about retries and why the order matters. '.repeat(
    5,
  ) +
  ending;

test.beforeAll(() => {
  folder = mkdtempSync(join(FIXTURE_L, '..', 'review-layout-'));
  cpSync(FIXTURE_L, folder, { recursive: true });
  const sessionDir = join(folder, '.vsdiff/sessions/2026-01-02-payments-refactor');
  const file = join(sessionDir, 'session.json');
  const session = JSON.parse(readFileSync(file, 'utf8'));
  session.chapters[0].stops[0].prose = prose;
  writeFileSync(file, JSON.stringify(session));
  feedbackFile = join(sessionDir, 'feedback.jsonl');
  rmSync(feedbackFile, { force: true });
});
test.afterAll(() => rmSync(folder, { recursive: true, force: true }));

test('focus review, pin/unpin, and long guide expansion preserve the conversation', async ({
  page,
}) => {
  page.setDefaultTimeout(15_000);
  await openWorkbench(page, folder);
  let bridge = await waitForBridge(folder);
  // A utility tab can be restored by VS Code before the review starts.
  await exec(bridge, 'workbench.action.files.newUntitledFile');
  await exec(bridge, 'vsdiff.openOverview');
  const overview = page.frameLocator('iframe.webview').last().frameLocator('#active-frame');
  await expect(overview.getByRole('button', { name: 'Pin Overview', exact: true })).toBeVisible();
  // Pin from the landing page with another tab, but no review diff yet.
  await overview.getByRole('button', { name: 'Pin Overview', exact: true }).click();
  await expect(overview.getByRole('button', { name: 'Unpin Overview', exact: true })).toBeVisible();
  await expect(page.locator('.editor-group-container')).toHaveCount(2);
  await expect(page.locator('.monaco-diff-editor')).toBeVisible();
  await overview.getByRole('button', { name: 'Unpin Overview', exact: true }).click();
  await expect(page.locator('.editor-group-container')).toHaveCount(1);
  await expect(
    page.getByRole('button', { name: 'Hide Secondary Side Bar (Ctrl+Alt+B)', exact: true }),
  ).not.toBeVisible();

  const card = overview.locator('.stop').first();
  await expect(card).not.toContainText(ending);
  await card.getByRole('button', { name: 'Show full guide', exact: true }).click();
  await expect(card).toContainText(ending);
  await exec(bridge, 'vsdiff.markStopDone', ['pipeline', true]);
  await expect(card.getByRole('button', { name: 'Show less' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );

  // Focus review is idempotent, and panels remain manually reopenable.
  await exec(bridge, 'workbench.action.toggleAuxiliaryBar');
  await exec(bridge, 'workbench.actions.view.problems');
  await expect(
    page.getByRole('button', { name: 'Hide Panel (Ctrl+J)', exact: true }),
  ).toBeVisible();
  await overview.getByRole('button', { name: 'Focus review' }).click();
  await expect(
    page.getByRole('button', { name: 'Hide Panel (Ctrl+J)', exact: true }),
  ).not.toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Hide Secondary Side Bar (Ctrl+Alt+B)', exact: true }),
  ).not.toBeVisible();

  await card.getByText('New capture pipeline', { exact: true }).click();
  const guide = page.locator('.review-widget').filter({ hasText: 'vsdiff · agent guide' }).first();
  await expect(guide).not.toContainText(ending);
  await guide.getByRole('button', { name: 'Show full guide', exact: true }).click();
  await expect(guide).toContainText(ending);
  await guide.getByRole('button', { name: 'Show less', exact: true }).click();
  await expect(guide).not.toContainText(ending);
  await expect(
    page.getByRole('button', { name: 'Hide Panel (Ctrl+J)', exact: true }),
  ).not.toBeVisible();

  await guide.locator('.review-thread-reply-button').click();
  const input = page.getByRole('textbox', { name: 'Editor content', exact: true });
  await input.pressSequentially('Keep my draft');
  await exec(bridge, 'vsdiff.openOverview');
  await overview.getByRole('button', { name: 'Pin Overview', exact: true }).click();
  await expect(overview.getByRole('button', { name: 'Unpin Overview', exact: true })).toBeVisible();
  await expect(page.locator('.editor-group-container')).toHaveCount(2);
  await card.getByText('New capture pipeline', { exact: true }).click();
  await expect(page.locator('.monaco-diff-editor')).toBeVisible();
  await expect(overview.getByRole('button', { name: 'Unpin Overview', exact: true })).toBeVisible();
  await overview.getByRole('button', { name: 'Unpin Overview', exact: true }).click();
  await expect(page.locator('.editor-group-container')).toHaveCount(1);
  await expect(overview.getByRole('button', { name: 'Pin Overview', exact: true })).toBeVisible();
  await card.getByText('New capture pipeline', { exact: true }).click();
  await input.pressSequentially(' through layout changes.');
  await input.press('Control+Enter');
  await expect
    .poll(() => readFileSync(feedbackFile, 'utf8'))
    .toContain('Keep my draft through layout changes.');

  // Remember the pin preference across browser reloads, then leave it unpinned.
  await exec(bridge, 'vsdiff.openOverview');
  await overview.getByRole('button', { name: 'Pin Overview', exact: true }).click();
  await expect(overview.getByRole('button', { name: 'Unpin Overview', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('tree', { name: 'Review Outline', exact: true })).toBeVisible();
  bridge = await waitForBridge(folder);
  await exec(bridge, 'vsdiff.openOverview');
  await expect(overview.getByRole('button', { name: 'Unpin Overview', exact: true })).toBeVisible();
  await expect(page.locator('.editor-group-container')).toHaveCount(2);
  await overview.getByRole('button', { name: 'Unpin Overview', exact: true }).click();
  await expect(page.locator('.editor-group-container')).toHaveCount(1);
  await page.screenshot({ path: shot('review-layout-overview.png') });
});
