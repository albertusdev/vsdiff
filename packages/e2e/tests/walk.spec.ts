import { expect, test } from '@playwright/test';
import { FIXTURE_L, exec, fetchState, openWorkbench, shot, waitForBridge } from './helpers.ts';

// The universal guided walk (round-5 ask): vsdiff.next/prev traverse every
// hunk of every stop in session order — within a stop first, then across the
// stop boundary — unlike the editor's diff arrows, which only cycle the file.
// The same commands back the chevron buttons on the diff editor title.

interface WalkShape {
  session: { currentIndex?: number };
  hunk: { hunkOrdinal: number; hunkCount: number };
}

async function pollPosition(
  bridge: Awaited<ReturnType<typeof waitForBridge>>,
  index: number,
  ordinal: number,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  let state = (await fetchState(bridge)) as unknown as WalkShape;
  while (
    (state.session.currentIndex !== index || state.hunk.hunkOrdinal !== ordinal) &&
    Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, 300));
    state = (await fetchState(bridge)) as unknown as WalkShape;
  }
  expect({ index: state.session.currentIndex, ordinal: state.hunk.hunkOrdinal }).toEqual({
    index,
    ordinal,
  });
}

test('universal next/prev walks hunks across stop boundaries', async ({ page }) => {
  await openWorkbench(page, FIXTURE_L);
  const bridge = await waitForBridge(FIXTURE_L);
  await exec(bridge, 'vsdiff.reload');
  await exec(bridge, 'vsdiff.openStop', [0]);
  await pollPosition(bridge, 0, 0);

  // Stop 0 has one hunk: next rolls over the boundary into stop 1 (which has
  // two hunks in two files), then walks within it, then rolls on to stop 2.
  await exec(bridge, 'vsdiff.next');
  await pollPosition(bridge, 1, 0);
  await exec(bridge, 'vsdiff.next');
  await pollPosition(bridge, 1, 1);
  await exec(bridge, 'vsdiff.next');
  await pollPosition(bridge, 2, 0);

  // Walking backward arrives on the previous stop's LAST hunk — a true walk.
  await exec(bridge, 'vsdiff.prev');
  await pollPosition(bridge, 1, 1);

  // The chevrons live on the diff editor title; clicking Next is the same walk.
  const nextButton = page.locator('a.action-label[aria-label*="Next in Review"]').first();
  await expect(nextButton).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: shot('78-walk-buttons.png') });
  await nextButton.click();
  await pollPosition(bridge, 2, 0);

  // The end of the review is an announced stop, not a wrap or a crash.
  await exec(bridge, 'vsdiff.openStop', [7]);
  await pollPosition(bridge, 7, 0);
  await exec(bridge, 'vsdiff.next');
  await new Promise((r) => setTimeout(r, 800));
  await pollPosition(bridge, 7, 0);
});
