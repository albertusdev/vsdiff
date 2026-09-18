import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { FIXTURE_L, exec, openWorkbench, shot, waitForBridge } from './helpers.ts';

// Use a fresh workspace so saved editor groups cannot mask the layout default.
let folder: string;
let feedbackFile: string;
test.beforeAll(() => {
  folder = mkdtempSync(join(FIXTURE_L, '..', 'web-ux-'));
  cpSync(FIXTURE_L, folder, { recursive: true });
  feedbackFile = join(folder, '.vsdiff/sessions/2026-01-02-payments-refactor/feedback.jsonl');
  rmSync(feedbackFile, { force: true });
});
test.afterAll(() => rmSync(folder, { recursive: true, force: true }));

function events(): Array<Record<string, unknown>> {
  return readFileSync(feedbackFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

test('full-width diff, guide reply, draft survival, reload, and palette comment', async ({
  page,
}) => {
  page.setDefaultTimeout(15_000);
  await openWorkbench(page, folder);
  let bridge = await waitForBridge(folder);
  await exec(bridge, 'vsdiff.openOverview');
  const overview = page.frameLocator('iframe.webview').last().frameLocator('#active-frame');
  await expect(overview.getByText('Payments refactor', { exact: true })).toBeVisible();
  await expect(page.locator('.editor-group-container')).toHaveCount(1);
  await overview.getByText('New capture pipeline', { exact: true }).click();
  await expect(page.locator('.monaco-diff-editor')).toBeVisible();
  await expect(page.locator('.editor-group-container')).toHaveCount(1);
  await expect(overview.getByText('Payments refactor', { exact: true })).not.toBeVisible();
  for (const name of ['Hide Panel (Ctrl+J)', 'Hide Secondary Side Bar (Ctrl+Alt+B)']) {
    const button = page.getByRole('button', { name, exact: true });
    if (await button.isVisible()) await button.click();
  }

  // This fails on the old build: guide threads explicitly disabled replies.
  await page.screenshot({ path: shot('web-ux-before-comment.png') });
  await expect(page.locator('.review-thread-reply-button').first()).toBeVisible({
    timeout: 15_000,
  });
  await page.locator('.review-thread-reply-button').first().click();
  const input = page.getByRole('textbox', { name: 'Editor content', exact: true });
  await input.pressSequentially('Please keep this guard.');
  await input.press('Enter');
  await input.pressSequentially('It protects retries.');
  // A live feedback update must not erase the draft or steal its focus.
  await exec(bridge, 'vsdiff.markStopDone', ['pipeline', true]);
  await input.pressSequentially(' Thanks.');
  await input.press('Control+Enter');
  const body = 'Please keep this guard.\nIt protects retries. Thanks.';
  await expect
    .poll(() => events().find((event) => event.body === body))
    .toMatchObject({
      type: 'comment',
      path: 'src/payments/capture.ts',
      line: 24,
      side: 'head',
      stop: 'pipeline',
    });
  await expect(
    page.getByRole('treeitem').filter({ hasText: 'Please keep this guard.' }).first(),
  ).toBeVisible();

  await page.locator('.review-thread-reply-button').first().click();
  await input.pressSequentially('A second message in the same thread.');
  await page
    .getByRole('button', { name: 'Comment for the agent (Ctrl+Enter)', exact: true })
    .click();
  await expect
    .poll(() => events().find((event) => event.type === 'reply'))
    .toMatchObject({
      thread: events().find((event) => event.body === body)!.id,
      body: 'A second message in the same thread.',
    });

  await page.reload();
  // Wait for this window's extension UI, then navigate through it. The old
  // window's dev bridge can still answer while serve-web reconnects.
  await page.getByRole('treeitem', { name: /^New capture pipeline/ }).click();
  bridge = await waitForBridge(folder);
  await expect(
    page.getByText('A second message in the same thread.', { exact: true }),
  ).toBeVisible();
  const restoredThread = page.getByLabel(
    'Comment thread with 3 comments on lines 24 through 24. open.',
    { exact: true },
  );
  await expect(restoredThread.getByText('vsdiff · agent guide', { exact: true })).toBeVisible();
  await expect(
    restoredThread.getByText('A second message in the same thread.', { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: shot('web-ux-comment-reloaded.png') });

  // Navigate to an uncommented line and invoke the real palette entry, with
  // no CommentReply argument (the old handler crashed reading `.thread`).
  await page.keyboard.press('Control+g');
  await page.getByRole('textbox', { name: /Go to line\./ }).fill(':25');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+Shift+p');
  await page
    .getByRole('textbox', { name: 'Type the name of a command to run.' })
    .fill('>Comment for the agent');
  await page.getByRole('option', { name: 'Comment for the agent', exact: true }).click();
  await expect(input).toBeVisible();
  await input.pressSequentially('Started from the command palette.');
  await input.press('Control+Enter');
  await expect
    .poll(() => events().find((event) => event.body === 'Started from the command palette.'))
    .toMatchObject({
      type: 'comment',
      path: 'src/payments/capture.ts',
      line: 25,
    });
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page
    .getByRole('toolbar', { name: 'Editor actions', exact: true })
    .getByRole('button', { name: 'vsdiff: Open Review Overview', exact: true })
    .click();
  await expect(overview.getByText('Payments refactor', { exact: true })).toBeVisible();
  await expect(page.locator('.editor-group-container')).toHaveCount(1);
});
