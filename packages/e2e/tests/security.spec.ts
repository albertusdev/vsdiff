import { createServer } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { FIXTURE_L, exec, fetchState, openWorkbench, waitForBridge } from './helpers.ts';

let folder: string;
let sessionDir: string;
test.beforeAll(() => {
  folder = mkdtempSync(join(FIXTURE_L, '..', 'security-'));
  cpSync(FIXTURE_L, folder, { recursive: true });
  sessionDir = join(folder, '.vsdiff/sessions/2026-01-02-payments-refactor');
  rmSync(join(sessionDir, 'feedback.jsonl'), { force: true });
});
test.afterAll(() => rmSync(folder, { recursive: true, force: true }));

test('hostile guide cannot bypass CSP or open files outside the workspace', async ({ page }) => {
  let requests = 0;
  const collector = createServer((_req, res) => {
    requests++;
    res.end('probe');
  });
  await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));
  const address = collector.address();
  if (!address || typeof address === 'string') throw new Error('missing collector');
  try {
    const sessionFile = join(sessionDir, 'session.json');
    const session = JSON.parse(readFileSync(sessionFile, 'utf8'));
    session.guide = { html: 'attack.html' };
    writeFileSync(sessionFile, JSON.stringify(session));
    // Deliberately put executable markup BEFORE <head>: inserting CSP inside
    // the attacker's head lets this request escape before the policy applies.
    writeFileSync(
      join(sessionDir, 'attack.html'),
      `<script>window.probe = fetch('http://127.0.0.1:${address.port}/sentinel').then(() => 'escaped', () => 'blocked');</script><html><head><title>Security fixture</title></head><body><h1>Security fixture</h1><p id="probe">pending</p><script>window.probe.then(result => document.getElementById('probe').textContent = result);</script></body></html>`,
    );
    await openWorkbench(page, folder);
    const bridge = await waitForBridge(folder);
    await exec(bridge, 'vsdiff.openStop', [0]);
    await exec(bridge, 'vsdiff.openGuide');
    const frame = page.frameLocator('iframe.webview').last().frameLocator('#active-frame');
    await expect(frame.getByText('trusted', { exact: false }).first()).toBeVisible();
    expect(requests).toBe(0);
    await exec(bridge, 'workbench.trust.manage');
    await page.getByRole('button', { name: 'Trust', exact: true }).first().click();
    await exec(bridge, 'workbench.action.closeActiveEditor');
    await expect(frame.locator('#probe')).toHaveText('blocked', { timeout: 30_000 });
    expect(requests).toBe(0);
    expect(await exec(bridge, 'vsdiff.debug.guideNav', ['../../outside.txt', 1])).toBeNull();
    expect(await exec(bridge, 'vsdiff.debug.guideNav', ['/etc/passwd', 1])).toBeNull();
    const outside = join(folder, '..', `outside-${Date.now()}.html`);
    writeFileSync(outside, '<h1>OUTSIDE SENTINEL</h1>');
    try {
      symlinkSync(outside, join(sessionDir, 'escape.html'));
      for (const path of ['../../../../outside.txt', 'escape.html']) {
        session.guide.html = path;
        writeFileSync(sessionFile, JSON.stringify(session));
        await exec(bridge, 'vsdiff.reload');
        await expect
          .poll(
            async () =>
              ((await fetchState(bridge)) as unknown as { guide: { available: boolean } }).guide
                .available,
          )
          .toBe(false);
        await exec(bridge, 'vsdiff.openGuide');
        await expect(page.getByText('OUTSIDE SENTINEL')).toHaveCount(0);
      }
    } finally {
      rmSync(outside, { force: true });
    }
    const attack = await fetch(`http://127.0.0.1:${bridge.port}/exec`, {
      method: 'POST',
      headers: { Origin: 'https://attacker.example', 'Content-Type': 'text/plain' },
      body: JSON.stringify({ command: 'vsdiff.debug.state' }),
    });
    expect(attack.status).toBe(403);
  } finally {
    await new Promise<void>((resolve) => collector.close(() => resolve()));
  }
});
