import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { appendFeedback } from '@vsdiff/core';
import {
  FIXTURE_L,
  exec,
  fetchState,
  openWorkbench,
  shot,
  waitForBridge,
  type BridgeInfo,
  type BridgeState,
} from './helpers.ts';

// P2: the conversation. Prose threads pinned over the diff, a human comment,
// an agent reply landing live, resolution, verdicts, and Finish Review writing
// result.json — the whole feedback loop end to end.

const SESSION_DIR = join(FIXTURE_L, '.vsdiff', 'sessions', '2026-01-02-payments-refactor');

interface FeedbackShape {
  events: number;
  threads: { prose: number; feedback: number; open: number };
  verdicts: Record<string, string>;
}

async function pollFeedback(
  bridge: BridgeInfo,
  predicate: (f: FeedbackShape) => boolean,
  timeoutMs = 20_000,
): Promise<BridgeState> {
  const deadline = Date.now() + timeoutMs;
  let state = await fetchState(bridge);
  while (Date.now() < deadline) {
    const feedback = (state as unknown as { feedback: FeedbackShape }).feedback;
    if (feedback && predicate(feedback)) return state;
    await new Promise((r) => setTimeout(r, 400));
    state = await fetchState(bridge);
  }
  throw new Error(`feedback state never matched: ${JSON.stringify(state)}`);
}

test.beforeAll(() => {
  // Each run starts the conversation fresh; the golden session itself is untouched.
  rmSync(join(SESSION_DIR, 'feedback.jsonl'), { force: true });
  rmSync(join(SESSION_DIR, 'result.json'), { force: true });
});

test('P2: prose over the diff, comment round trip, verdict, finish', async ({ page }) => {
  await openWorkbench(page, FIXTURE_L);
  const bridge = await waitForBridge(FIXTURE_L);

  // Reload so the extension picks up the wiped feedback state from beforeAll.
  await exec(bridge, 'vsdiff.reload');
  await exec(bridge, 'vsdiff.openStop', [0]);
  await expect(page.locator('.monaco-diff-editor').first()).toBeVisible({ timeout: 20_000 });

  // The agent's narrative rides a pinned comment thread at the stop's hunk.
  // 8 stops across 8 distinct files, one of them two-file → 9 pinned notes.
  await pollFeedback(bridge, (f) => f.threads.prose === 9);
  await expect(page.getByText('vsdiff · agent guide').first()).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: shot('20-prose-thread.png') });

  // Human comments (debug command = the R18-parity path the UI reply box shares).
  const threadId = (await exec(bridge, 'vsdiff.debug.comment', [
    'src/payments/capture.ts',
    26, // inside hunk h1 (@@ +24,10) — in the revealed viewport
    'Why not reuse the retry queue from api/client here?',
  ])) as string;
  expect(threadId).toMatch(/^t/);
  await pollFeedback(bridge, (f) => f.threads.feedback === 1 && f.threads.open === 1);

  // The agent replies out-of-band (the CLI path writes the same file).
  await appendFeedback(SESSION_DIR, {
    type: 'reply',
    thread: threadId,
    body: 'Good call — unified in the follow-up commit.',
    author: 'agent',
  });
  await pollFeedback(bridge, (f) => f.events >= 2);
  await expect(page.getByText('Good call — unified').first()).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: shot('21-comment-round-trip.png') });

  // Agent resolves the thread; the editor reflects it live.
  await appendFeedback(SESSION_DIR, { type: 'resolve', thread: threadId, by: 'agent' });
  await pollFeedback(bridge, (f) => f.threads.open === 0);

  // Verdict + finish.
  await exec(bridge, 'vsdiff.verdict.accept');
  await pollFeedback(bridge, (f) => f.verdicts['pipeline'] === 'accepted');
  const result = (await exec(bridge, 'vsdiff.finishReview', ['approved'])) as {
    status: string;
    verdicts: { accepted: number };
    openThreads: string[];
  };
  expect(result.status).toBe('approved');
  expect(result.verdicts.accepted).toBe(1);
  expect(result.openThreads).toEqual([]);

  const onDisk = JSON.parse(readFileSync(join(SESSION_DIR, 'result.json'), 'utf8')) as {
    status: string;
  };
  expect(onDisk.status).toBe('approved');
});
