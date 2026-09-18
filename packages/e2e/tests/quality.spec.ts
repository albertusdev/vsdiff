import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { FIXTURE_L, exec, fetchState, openWorkbench, shot, waitForBridge } from './helpers.ts';

// Round-7 quality batch: load-time validation surfacing (duplicate hunk claims
// once rendered silently), the beside layout (overview stays visible while
// diffs open), the seen-hunk coverage fold + heatmap card, and must/nice tiers.
// Like proposal.spec, this writes its own session (newer mtime wins) and
// removes it in afterAll so the golden walkthrough session stays authoritative.

const SESSION_DIR = join(FIXTURE_L, '.vsdiff', 'sessions', '2026-01-04-quality-check');
const SETTINGS_FILE = join(FIXTURE_L, '.vscode', 'settings.json');
let originalSettings: string | undefined;

const SESSION = {
  version: 1,
  kind: 'review',
  title: 'Quality check session',
  focus: 'Deliberately imperfect: one duplicate claim, one nice-to-review chapter.',
  source: { type: 'range', base: 'main', head: 'HEAD' },
  chapters: [
    {
      id: 'core',
      title: 'Core',
      blurb: 'The load-bearing part.',
      stops: [
        {
          id: 'first-claim',
          kind: 'walkthrough',
          title: 'Capture entry point',
          prose: 'Owns the hunk.',
          hunkIds: ['src/payments/capture.ts:h1'],
        },
        {
          id: 'second-claim',
          kind: 'finding',
          severity: 'minor',
          title: 'Duplicate claimant',
          prose: 'Claims the same hunk — the validator must flag this.',
          hunkIds: ['src/payments/capture.ts:h1'],
        },
      ],
    },
    {
      id: 'devx',
      title: 'Dev experience',
      priority: 'nice',
      blurb: 'Internal-facing docs tweak — easily reversible, FYI only.',
      stops: [
        {
          id: 'docs-tweak',
          kind: 'walkthrough',
          title: 'Docs housekeeping',
          prose: 'Markdown only.',
          hunkIds: ['docs/payments.md:h1'],
        },
      ],
    },
  ],
};

interface QualityShape {
  issues: string[];
  feedback: { seen: string[]; read: string[]; done: string[] };
  session: { currentIndex?: number };
}

test.beforeAll(() => {
  // Beside is now opt-in; this suite exercises that explicit preference.
  originalSettings = existsSync(SETTINGS_FILE) ? readFileSync(SETTINGS_FILE, 'utf8') : undefined;
  mkdirSync(join(FIXTURE_L, '.vscode'), { recursive: true });
  writeFileSync(
    SETTINGS_FILE,
    JSON.stringify({
      ...JSON.parse(originalSettings ?? '{}'),
      'vsdiff.overview.layout': 'beside',
    }),
  );
  mkdirSync(SESSION_DIR, { recursive: true });
  writeFileSync(join(SESSION_DIR, 'session.json'), `${JSON.stringify(SESSION, null, 2)}\n`);
  rmSync(join(SESSION_DIR, 'feedback.jsonl'), { force: true });
  rmSync(join(SESSION_DIR, 'result.json'), { force: true });
});

test.afterAll(async () => {
  if (originalSettings === undefined) rmSync(SETTINGS_FILE, { force: true });
  else writeFileSync(SETTINGS_FILE, originalSettings);
  rmSync(SESSION_DIR, { recursive: true, force: true });
  try {
    const bridge = await waitForBridge(FIXTURE_L, 10_000);
    await exec(bridge, 'vsdiff.reload');
  } catch {
    // ext host may be gone; the deletion is what matters
  }
});

test('validation banner, beside layout, coverage heatmap, must/nice tiers', async ({ page }) => {
  await openWorkbench(page, FIXTURE_L);
  const bridge = await waitForBridge(FIXTURE_L);
  await exec(bridge, 'vsdiff.reload');

  // Load-time validation: the duplicate claim is surfaced, not silently drawn.
  const deadline = Date.now() + 20_000;
  let state = (await fetchState(bridge)) as unknown as QualityShape;
  while (!(state.issues?.length > 0) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    state = (await fetchState(bridge)) as unknown as QualityShape;
  }
  expect(state.issues.join('\n')).toContain('already claimed');

  // A reused ext host (page churn under 15s) can hold a zombie panel from the
  // previous run — same session path, so auto-open skips. An explicit reveal
  // goes through the panel's rebuild-if-not-visible path.
  await exec(bridge, 'vsdiff.openOverview');
  await new Promise((r) => setTimeout(r, 800));
  const frame = page.frameLocator('iframe.webview').last().frameLocator('#active-frame');
  await expect(frame.getByText('Quality check session').first()).toBeVisible({ timeout: 20_000 });
  await expect(frame.getByText('validation issue').first()).toBeVisible({ timeout: 15_000 });

  // Beside layout: opening a diff does NOT bury the overview — both visible.
  await exec(bridge, 'vsdiff.openStop', [0]);
  await expect(page.locator('.monaco-diff-editor').first()).toBeVisible({ timeout: 20_000 });
  // Under suite load the beside choreography can still be settling; a reveal
  // is idempotent and the panel rebuilds itself if the iframe was mid-swap.
  await exec(bridge, 'vsdiff.openOverview');
  await expect(page.locator('.monaco-diff-editor').first()).toBeVisible({ timeout: 10_000 });
  await expect(frame.getByText('Quality check session').first()).toBeVisible({ timeout: 20_000 });

  // The navigation marked the opened hunk seen (coverage's automatic signal).
  const seenDeadline = Date.now() + 15_000;
  let seen = (await fetchState(bridge)) as unknown as QualityShape;
  while (!seen.feedback.seen.includes('src/payments/capture.ts:h1') && Date.now() < seenDeadline) {
    await new Promise((r) => setTimeout(r, 400));
    seen = (await fetchState(bridge)) as unknown as QualityShape;
  }
  expect(seen.feedback.seen).toContain('src/payments/capture.ts:h1');

  // autoDone on-read (the default): the hunk is small enough to fit on screen,
  // so after a dwell tick its whole span has been visible → read → the stop
  // checks itself off without a click.
  const autoDeadline = Date.now() + 15_000;
  let auto = (await fetchState(bridge)) as unknown as QualityShape;
  while (!auto.feedback.done.includes('first-claim') && Date.now() < autoDeadline) {
    await new Promise((r) => setTimeout(r, 400));
    auto = (await fetchState(bridge)) as unknown as QualityShape;
  }
  expect(auto.feedback.done).toContain('first-claim');
  expect(auto.feedback.read).toContain('src/payments/capture.ts:h1');

  // Coverage card: totals in the header, rows after expanding. The expand
  // state persists in webview state, so a reused panel may start open.
  await expect(frame.getByText('hunks done').first()).toBeVisible({ timeout: 15_000 });
  for (let i = 0; i < 3 && (await frame.locator('.cov-row').count()) === 0; i++) {
    await frame.locator('[data-covtoggle]').click();
    await page.waitForTimeout(700);
  }
  await expect(frame.locator('.cov-row').first()).toBeVisible({ timeout: 10_000 });

  // Tiers: musts-only hides the nice chapter, toggling back shows it. The
  // filter persists in webview state, so normalise to "All" first.
  await expect(frame.getByText(/musts 1\/2/).first()).toBeVisible({ timeout: 10_000 });
  if ((await frame.getByText('Dev experience').count()) === 0) {
    await frame.locator('[data-tierfilter]').click();
  }
  await expect(frame.getByText('nice · FYI').first()).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: shot('80-quality.png') });
  await frame.locator('[data-tierfilter]').click();
  await expect(frame.getByText('Dev experience')).toHaveCount(0, { timeout: 10_000 });
  await frame.locator('[data-tierfilter]').click();
  await expect(frame.getByText('Dev experience').first()).toBeVisible({ timeout: 10_000 });

  // Approve gate: the INTERACTIVE path (no status argument → QuickPick) warns
  // about unfinished musts; the programmatic path (explicit status) never
  // blocks — agents drive that one.
  const finishing = exec(bridge, 'vsdiff.finishReview');
  const approvePick = page
    .locator('.quick-input-widget .monaco-list-row', { hasText: 'Approve' })
    .first();
  await expect(approvePick).toBeVisible({ timeout: 15_000 });
  await approvePick.click();
  const dialogButton = page
    .locator('.monaco-dialog-box .monaco-text-button', { hasText: 'Approve anyway' })
    .first();
  await expect(dialogButton).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/must-review stop/).first()).toBeVisible();
  await dialogButton.click();
  await finishing;
  expect(existsSync(join(SESSION_DIR, 'result.json'))).toBe(true);
  const result = JSON.parse(readFileSync(join(SESSION_DIR, 'result.json'), 'utf8')) as {
    status: string;
  };
  expect(result.status).toBe('approved');
});
