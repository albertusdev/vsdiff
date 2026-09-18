import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Page } from '@playwright/test';

export const ROOT = resolve(import.meta.dirname, '..', '..', '..');
export const SHOTS = join(ROOT, '.dev', 'shots');
export const FIXTURE_S = join(ROOT, '.dev', 'fixtures', 's-repo');
export const FIXTURE_L = join(ROOT, '.dev', 'fixtures', 'l-repo');
const BRIDGE_FILE = join(ROOT, '.dev', 'bridge.json');

export interface BridgeInfo {
  port: number;
  pid: number;
  token: string;
}

export interface BridgeState {
  extension: { id: string; version: string };
  workspaceFolders: string[];
  outline: string[];
  session: {
    phase: string;
    title?: string;
    stops?: number;
    currentIndex?: number;
    stats?: { totalHunks: number; coveredHunks: number; staleStops: number; missingRefs: number };
  };
  perf: { loadMs?: number; lastNavMs?: number };
}

/** The bridge file is written by the extension on activation — it doubles as
 *  the "extension host is up" signal. One serve-web instance hosts every test
 *  workspace, each with its own extension host overwriting the bridge file,
 *  so callers that open a folder must pass it to get *their* host. */
export async function waitForBridge(
  expectFolder?: string,
  timeoutMs = 90_000,
): Promise<BridgeInfo> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'bridge file never appeared';
  while (Date.now() < deadline) {
    try {
      const info = JSON.parse(readFileSync(BRIDGE_FILE, 'utf8')) as BridgeInfo;
      const state = await fetchState(info);
      if (!expectFolder || state.workspaceFolders.some((f) => f === expectFolder)) {
        return info;
      }
      lastError = `bridge belongs to ${state.workspaceFolders.join(',')}, want ${expectFolder}`;
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`dev bridge not reachable within ${timeoutMs}ms: ${lastError}`);
}

export async function fetchState(bridge: BridgeInfo): Promise<BridgeState> {
  const response = await fetch(`http://127.0.0.1:${bridge.port}/state`, {
    headers: { Authorization: `Bearer ${bridge.token}` },
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error(`bridge /state → ${response.status}`);
  const body = (await response.json()) as { state: BridgeState };
  return body.state;
}

export async function exec(
  bridge: BridgeInfo,
  command: string,
  args: unknown[] = [],
): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${bridge.port}/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${bridge.token}` },
    body: JSON.stringify({ command, args }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json()) as { ok: boolean; result: unknown; error?: string };
  if (!body.ok) throw new Error(`exec ${command} failed: ${body.error}`);
  return body.result;
}

export async function openWorkbench(page: Page, folder: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  const query = new URLSearchParams({
    folder,
    tkn: readFileSync(join(ROOT, '.dev', 'web-token'), 'utf8'),
  });
  await page.goto(`/?${query}`);
  await page.waitForSelector('.monaco-workbench', { timeout: 90_000 });
  // Workspace trust is declared supported, but dismiss any prompt defensively.
  const trustButton = page.getByRole('button', { name: /trust the authors/i }).first();
  try {
    await trustButton.click({ timeout: 5_000 });
  } catch {
    // no dialog — the normal path
  }
}

export function shot(name: string): string {
  return join(SHOTS, name);
}
