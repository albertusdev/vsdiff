import { execFile, spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import {
  FIXTURE_L,
  ROOT,
  exec,
  fetchState,
  openWorkbench,
  waitForBridge,
  type BridgeInfo,
} from './helpers.ts';

// P2 exit criterion: the scripted agent plays its side through the REAL CLI —
// comment lands, agent replies and resolves via `vsdiff reply/resolve`, then
// `vsdiff open --await` blocks until the human's Finish Review unblocks it
// with an approved ResultDoc.

const execFileAsync = promisify(execFile);
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'main.mjs');
const SESSION_DIR = join(FIXTURE_L, '.vsdiff', 'sessions', '2026-01-02-payments-refactor');
const CLI_ENV = { ...process.env, VSDIFF_NO_LAUNCH: '1' };

function cli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('node', [CLI, ...args], { cwd: FIXTURE_L, env: CLI_ENV });
}

async function pollEvents(bridge: BridgeInfo, min: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = (await fetchState(bridge)) as unknown as { feedback: { events: number } };
    if (state.feedback.events >= min) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`never saw ${min} feedback events`);
}

test.beforeAll(() => {
  rmSync(join(SESSION_DIR, 'feedback.jsonl'), { force: true });
  rmSync(join(SESSION_DIR, 'result.json'), { force: true });
});

test('P2 exit: agent services the review through the CLI, --await unblocks on finish', async ({
  page,
}) => {
  await openWorkbench(page, FIXTURE_L);
  const bridge = await waitForBridge(FIXTURE_L);
  await exec(bridge, 'vsdiff.reload');

  // Human leaves a comment (parity path shared with the UI reply box).
  const threadId = (await exec(bridge, 'vsdiff.debug.comment', [
    'src/api/client.ts',
    38,
    'Retry budget interacts with the capture guard — is that covered by a test?',
  ])) as string;
  await pollEvents(bridge, 1);

  // Agent reads the feedback and answers through the CLI.
  const feed = await cli(['feedback', '--json']);
  const batch = JSON.parse(feed.stdout) as { events: Array<{ type: string; id?: string }> };
  expect(batch.events.some((e) => e.type === 'comment' && e.id === threadId)).toBe(true);

  await cli(['reply', '--thread', threadId, '--body', 'Added in tests/api-client — see case 7.']);
  await pollEvents(bridge, 2);
  await cli(['resolve', '--thread', threadId]);
  await pollEvents(bridge, 3);

  // Agent parks on the blocking handoff…
  const awaiting = spawn('node', [CLI, 'open', '--await', '--timeout', '60'], {
    cwd: FIXTURE_L,
    env: CLI_ENV,
  });
  const stdout: Buffer[] = [];
  awaiting.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  const exited = new Promise<number>((resolve) =>
    awaiting.on('exit', (code) => resolve(code ?? -1)),
  );

  // …the human verdicts and finishes in the editor…
  await new Promise((r) => setTimeout(r, 1500));
  await exec(bridge, 'vsdiff.verdict.accept');
  await exec(bridge, 'vsdiff.finishReview', ['approved']);

  // …and the agent resumes with the structured result.
  const code = await exited;
  const result = JSON.parse(Buffer.concat(stdout).toString('utf8')) as {
    status: string;
    verdicts: { accepted: number };
    openThreads: string[];
  };
  expect(code).toBe(0);
  expect(result.status).toBe('approved');
  expect(result.verdicts.accepted).toBe(1);
  expect(result.openThreads).toEqual([]);
});
