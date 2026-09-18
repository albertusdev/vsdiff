import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { writeResult, type ResultDoc } from '@vsdiff/core';
import {
  awaitResult,
  canceledResult,
  clearResult,
  exitCodeForStatus,
  isTerminalStatus,
} from './await-cmd.ts';

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.length = 0;
});

function makeSessionDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'vsdiff-cli-await-'));
  tempRoots.push(root);
  return root;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function result(status: ResultDoc['status']): ResultDoc {
  return {
    status,
    verdicts: { accepted: 9, needsWork: 2, questions: 1 },
    openThreads: ['t1', 't4'],
    finishedAt: '2026-08-19T10:30:00Z',
  };
}

test('resolves on the result written while it waits', async () => {
  const dir = makeSessionDir();

  const pending = awaitResult(dir, { timeoutMs: 4000, pollMs: 20 });
  await delay(60);
  await writeResult(dir, result('changes-requested'));

  const doc = await pending;
  expect(doc).toEqual(result('changes-requested'));
  expect(doc.reason).toBeUndefined();
  expect(exitCodeForStatus(doc.status)).toBe(0);
});

test('a stale result from a previous run never satisfies a new wait', async () => {
  const dir = makeSessionDir();
  await writeResult(dir, result('approved'));
  expect(existsSync(join(dir, 'result.json'))).toBe(true);

  const doc = await awaitResult(dir, { timeoutMs: 60, pollMs: 10 });

  expect(doc.status).toBe('canceled');
  expect(doc.reason).toBe('timeout');
  expect(existsSync(join(dir, 'result.json'))).toBe(false);
});

test('timeout produces a ResultDoc-shaped canceled document', async () => {
  const dir = makeSessionDir();
  const doc = await awaitResult(dir, { timeoutMs: 30, pollMs: 10 });

  expect(doc.status).toBe('canceled');
  expect(doc.reason).toBe('timeout');
  expect(doc.verdicts).toEqual({ accepted: 0, needsWork: 0, questions: 0 });
  expect(doc.openThreads).toEqual([]);
  expect(Date.parse(doc.finishedAt)).not.toBeNaN();
  expect(exitCodeForStatus(doc.status)).toBe(2);
});

test('a non-terminal status is ignored until a terminal one lands', async () => {
  const dir = makeSessionDir();

  const pending = awaitResult(dir, { timeoutMs: 4000, pollMs: 10 });
  await delay(40);
  await writeResult(dir, { ...result('approved'), status: 'in-progress' } as unknown as ResultDoc);
  await delay(60);
  await writeResult(dir, result('closed'));

  expect((await pending).status).toBe('closed');
});

test('an abort ends the wait as canceled, not approved', async () => {
  const dir = makeSessionDir();
  const controller = new AbortController();

  // timeoutMs 0 = wait forever; only the abort can end this.
  const pending = awaitResult(dir, { timeoutMs: 0, pollMs: 20, signal: controller.signal });
  await delay(40);
  controller.abort();

  const doc = await pending;
  expect(doc.status).toBe('canceled');
  expect(doc.reason).toBe('aborted');
  expect(exitCodeForStatus(doc.status)).toBe(2);
});

test('clearResult is a no-op when there is nothing to clear', async () => {
  const dir = makeSessionDir();
  await expect(clearResult(dir)).resolves.toBeUndefined();
  await expect(clearResult(join(dir, 'missing'))).resolves.toBeUndefined();
});

test('only canceled is a failed handoff', () => {
  expect(exitCodeForStatus('approved')).toBe(0);
  expect(exitCodeForStatus('changes-requested')).toBe(0);
  expect(exitCodeForStatus('closed')).toBe(0);
  expect(exitCodeForStatus('canceled')).toBe(2);
  expect(canceledResult('timeout').status).toBe('canceled');
});

test('terminal statuses are exactly the four documented ones', () => {
  for (const status of ['approved', 'changes-requested', 'closed', 'canceled']) {
    expect(isTerminalStatus(status)).toBe(true);
  }
  for (const status of ['in-progress', '', undefined, null, 7]) {
    expect(isTerminalStatus(status)).toBe(false);
  }
});
