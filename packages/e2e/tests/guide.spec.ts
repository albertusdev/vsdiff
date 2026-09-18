import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  FIXTURE_L,
  exec,
  fetchState,
  openWorkbench,
  shot,
  waitForBridge,
  type BridgeInfo,
} from './helpers.ts';

// P6 / R14: HTML guides. The agent ships an HTML file next to session.json and
// the editor renders it in a webview whose injected bridge drives navigation.
// Like proposal.spec.ts, this writes its own session (newer mtime wins) plus a
// guide directory into the L fixture and removes both in afterAll — every other
// spec asserts against the golden walkthrough session.

const GUIDE_SESSION_DIR = join(FIXTURE_L, '.vsdiff', 'sessions', '2026-01-04-guided-tour');
const GUIDE_DIR = join(GUIDE_SESSION_DIR, 'guide');

const SESSION = {
  version: 1,
  kind: 'review',
  title: 'Guided tour: capture rework',
  focus: 'The HTML guide is the review path; the stops are where it lands you.',
  source: { type: 'range', base: 'main', head: 'HEAD' },
  guide: { html: 'guide/index.html' },
  chapters: [
    {
      id: 'capture',
      title: 'Capture',
      stops: [
        {
          id: 'intro',
          kind: 'walkthrough',
          title: 'New capture pipeline',
          prose: 'Start here: `capture` now owns the retry loop it used to delegate.',
          hunkIds: ['src/payments/capture.ts:h1'],
        },
        {
          id: 'retry-guard',
          kind: 'finding',
          severity: 'major',
          title: 'Double-charge guard lost on retry',
          prose: 'The retry path re-enters `capture` without re-checking `idempotencyKey`.',
          hunkIds: ['src/payments/capture.ts:h2'],
        },
        {
          id: 'docs-drift',
          kind: 'finding',
          severity: 'minor',
          title: 'Docs lag the new flow',
          prose: '`docs/payments.md` still documents the old two-phase capture.',
          hunkIds: ['docs/payments.md:h1'],
        },
      ],
    },
  ],
};

// A relative asset reference (rewritten to a webview uri), a `vsdiff://` link, a
// button on `window.vsdiff.openStop`, and inline JS reading `window.vsdiff.state`
// — the whole contract on one page.
const BADGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <circle cx="12" cy="12" r="11" fill="none" stroke="currentColor" stroke-width="2"/>
  <path d="M7 12l3 3 7-7" fill="none" stroke="currentColor" stroke-width="2"/>
</svg>
`;

const GUIDE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Capture rework — guide</title>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         background: var(--vscode-editor-background); padding: 28px 34px; line-height: 1.55; }
  h1 { font-size: 1.35rem; margin: 0 0 .25rem; }
  p { max-width: 42rem; }
  a { color: var(--vscode-textLink-foreground); }
  button { font: inherit; padding: 6px 12px; border: 0; border-radius: 3px; cursor: pointer;
           background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  #badge { color: var(--vscode-charts-green); vertical-align: -4px; }
  #state { font-family: var(--vscode-editor-font-family); color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<h1><img id="badge" src="assets/badge.svg" alt=""> Capture rework — the two-minute tour</h1>
<p>A timeout used to charge twice. Read the retry guard first; the docs drift is the cleanup.</p>
<p><a id="to-retry" href="vsdiff://stop/retry-guard">Open the retry guard finding →</a></p>
<p>
  <button id="to-docs" onclick="window.vsdiff.openStop('docs-drift')">Show the docs drift</button>
  <button id="to-file" onclick="window.vsdiff.openFile('src/api/client.ts', 12)">Open client.ts:12</button>
</p>
<p id="state">state: pending</p>
<script>
  function paint() {
    var state = window.vsdiff && window.vsdiff.state;
    if (!state) return;
    var stop = state.stops[state.currentIndex] || { id: 'none' };
    document.title = state.title + ' @' + state.currentIndex;
    document.getElementById('state').textContent =
      'stops: ' + state.stops.length + ' · current: ' + state.currentIndex + ' · ' + stop.id;
  }
  window.addEventListener('vsdiff:state', paint);
  paint();
</script>
</body>
</html>
`;

interface GuideShape {
  available: boolean;
  open: boolean;
  trusted: boolean;
  ready: boolean;
  path?: string;
}

interface GuideBridgeState {
  guide: GuideShape;
  session: { phase: string; title?: string; stops?: number; currentIndex?: number };
}

async function pollGuide(
  bridge: BridgeInfo,
  predicate: (state: GuideBridgeState) => boolean,
  timeoutMs = 30_000,
): Promise<GuideBridgeState> {
  const deadline = Date.now() + timeoutMs;
  let state = (await fetchState(bridge)) as unknown as GuideBridgeState;
  while (Date.now() < deadline) {
    if (state.guide && predicate(state)) return state;
    await new Promise((r) => setTimeout(r, 400));
    state = (await fetchState(bridge)) as unknown as GuideBridgeState;
  }
  throw new Error(`guide state never matched: ${JSON.stringify(state)}`);
}

/** serve-web keeps workspace trust client-side (worklog landmine #1), so every
 *  harness run starts in Restricted Mode — which is where the guide's trust gate
 *  lives. Grant it through the workspace-trust editor, the way a human would. */
async function grantTrust(page: Page, bridge: BridgeInfo): Promise<void> {
  await exec(bridge, 'workbench.trust.manage');
  await page.getByRole('button', { name: 'Trust', exact: true }).first().click({ timeout: 30_000 });
}

test.beforeAll(() => {
  mkdirSync(join(GUIDE_DIR, 'assets'), { recursive: true });
  writeFileSync(join(GUIDE_SESSION_DIR, 'session.json'), `${JSON.stringify(SESSION, null, 2)}\n`);
  writeFileSync(join(GUIDE_DIR, 'index.html'), GUIDE_HTML);
  writeFileSync(join(GUIDE_DIR, 'assets', 'badge.svg'), BADGE_SVG);
});

test.afterAll(async () => {
  rmSync(GUIDE_SESSION_DIR, { recursive: true, force: true });
  try {
    const bridge = await waitForBridge(FIXTURE_L, 10_000);
    await exec(bridge, 'vsdiff.reload');
  } catch {
    // The extension host may already be gone — the deletion is what matters.
  }
});

test('P6: the HTML guide renders and its bridge drives navigation', async ({ page }) => {
  await openWorkbench(page, FIXTURE_L);
  const bridge = await waitForBridge(FIXTURE_L);
  await exec(bridge, 'vsdiff.reload');

  const loaded = await pollGuide(
    bridge,
    (state) => state.session.title === 'Guided tour: capture rework' && state.guide.available,
  );
  expect(loaded.guide).toMatchObject({ available: true, open: false, trusted: false });
  expect(loaded.guide.path).toBe('guide/index.html');

  // The outline's title button is gated on the vsdiff.hasGuide context key.
  await exec(bridge, 'vsdiff.outline.focus');
  await expect(page.getByRole('button', { name: /Open HTML Guide/i }).first()).toBeVisible({
    timeout: 20_000,
  });

  // Open a stop first so the guide lands in the group beside the diff — that is
  // also the layout a reader gets: guide on the right, code on the left.
  await exec(bridge, 'vsdiff.openStop', [0]);
  await expect(page.locator('.monaco-diff-editor').first()).toBeVisible({ timeout: 20_000 });

  const opened = (await exec(bridge, 'vsdiff.openGuide')) as GuideShape;
  expect(opened).toMatchObject({ available: true, open: true, trusted: false });
  const openState = await pollGuide(bridge, (state) => state.guide.open);
  expect(openState.guide.open).toBe(true);

  // Webviews are nested iframes: the workbench hosts the webview page (served
  // out of process, so give it room), which hosts the guide itself.
  await expect(page.locator('iframe.webview').first()).toBeAttached({ timeout: 60_000 });
  const frame = page.frameLocator('iframe.webview').last().frameLocator('iframe#active-frame');

  // Restricted Mode: the explainer renders, the agent's HTML never does.
  await expect(frame.getByText('trusted', { exact: false }).first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(frame.locator('#to-retry')).toHaveCount(0);
  await expect(frame.locator('#state')).toHaveCount(0);
  // …and no script of any kind ran: nothing handshaked with the bridge.
  const restricted = (await fetchState(bridge)) as unknown as GuideBridgeState;
  expect(restricted.guide.ready).toBe(false);
  await page.screenshot({ path: shot('50-html-guide-restricted.png') });

  // Trust granted → the open panel re-renders itself into the real guide, with
  // no second openGuide in the loop. The injected bridge handshakes on load,
  // which is the deterministic "the guide is live" signal.
  await grantTrust(page, bridge);
  await pollGuide(bridge, (state) => state.guide.trusted && state.guide.ready, 60_000);
  await expect(frame.locator('h1')).toContainText('Capture rework', { timeout: 30_000 });
  // The trust editor opens over the workbench; put the guide back in view.
  await exec(bridge, 'workbench.action.closeActiveEditor');
  // The inline script read window.vsdiff.state at load.
  await expect(frame.locator('#state')).toContainText('stops: 3', { timeout: 15_000 });
  // Relative assets are rewritten to webview uris; nothing loads over the network.
  const badge = await frame.locator('#badge').getAttribute('src');
  expect(badge).toMatch(/^https?:\/\//);
  expect(badge).toContain('assets/badge.svg');

  // A plain vsdiff:// link navigates the editor.
  await frame.locator('#to-retry').click();
  const afterLink = await pollGuide(bridge, (state) => state.session.currentIndex === 1);
  expect(afterLink.session.currentIndex).toBe(1);

  // …and so does window.vsdiff.openStop from the guide's own script.
  await frame.locator('#to-docs').click();
  await pollGuide(bridge, (state) => state.session.currentIndex === 2);
  // The state push comes back the other way: the guide re-renders on the move.
  await expect(frame.locator('#state')).toContainText('current: 2 · docs-drift', {
    timeout: 15_000,
  });
  await expect(page.locator('.monaco-diff-editor').first()).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: shot('50-html-guide.png') });

  // window.vsdiff.openFile lands on a file:line, not a stop.
  await frame.locator('#to-file').click();
  await expect(page.locator('.tab.active', { hasText: 'client.ts' }).first()).toBeVisible({
    timeout: 20_000,
  });

  // R18 parity: the same message handler without a webview in the loop.
  await exec(bridge, 'vsdiff.debug.guideNav', ['intro']);
  const afterDebug = await pollGuide(bridge, (state) => state.session.currentIndex === 0);
  expect(afterDebug.session.currentIndex).toBe(0);
  const openedFile = (await exec(bridge, 'vsdiff.debug.guideNav', [
    'src/payments/refund.ts',
    3,
  ])) as string;
  expect(openedFile).toContain('src/payments/refund.ts');

  // The file on disk is the contract: take the guide away and the command says
  // so instead of opening an empty panel.
  const guideFile = join(GUIDE_DIR, 'index.html');
  renameSync(guideFile, `${guideFile}.away`);
  expect(await exec(bridge, 'vsdiff.openGuide')).toBeNull();
  const missing = (await fetchState(bridge)) as unknown as GuideBridgeState;
  expect(missing.guide.available).toBe(false);
  renameSync(`${guideFile}.away`, guideFile);
  const reopened = (await exec(bridge, 'vsdiff.openGuide')) as GuideShape;
  expect(reopened).toMatchObject({ available: true, open: true, trusted: true });
});
