import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { appendFeedback, readFeedback, type CommentEvent, type ReplyEvent } from '@vsdiff/core';
import {
  appendComment,
  appendReply,
  appendResolve,
  collectFeedback,
  newThreadId,
} from './feedback-cmd.ts';

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.length = 0;
});

function makeSessionDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'vsdiff-cli-feedback-'));
  tempRoots.push(root);
  return root;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('reply, resolve and comment land in the log authored by the agent', async () => {
  const dir = makeSessionDir();

  const comment = await appendComment(dir, {
    path: 'src/auth/middleware.ts',
    line: 54,
    body: 'queue unified here',
    stop: 'refresh-race',
  });
  const reply = await appendReply(dir, { thread: 't1', body: 'good call — unified in 3f2a1c9' });
  const resolve = await appendResolve(dir, { thread: 't1' });

  const batch = await readFeedback(dir);
  expect(batch.malformed).toBe(0);
  expect(batch.nextLine).toBe(3);
  expect(batch.events[0]).toEqual({
    type: 'comment',
    ts: comment.ts,
    id: comment.id,
    path: 'src/auth/middleware.ts',
    line: 54,
    body: 'queue unified here',
    author: 'agent',
    stop: 'refresh-race',
  });
  expect(batch.events[1]).toEqual({
    type: 'reply',
    ts: reply.ts,
    thread: 't1',
    body: 'good call — unified in 3f2a1c9',
    author: 'agent',
  });
  expect(batch.events[2]).toEqual({ type: 'resolve', ts: resolve.ts, thread: 't1', by: 'agent' });
  expect(Date.parse(comment.ts)).not.toBeNaN();
});

test('a comment without --stop omits the field entirely', async () => {
  const dir = makeSessionDir();
  await appendComment(dir, { path: 'src/a.ts', line: 1, body: 'nit' });

  const event = (await readFeedback(dir)).events[0] as CommentEvent;
  expect('stop' in event).toBe(false);
});

test('generated thread ids are shaped t<epoch>-<4 hex> and do not collide', () => {
  const ids = new Set<string>();
  for (let i = 0; i < 500; i++) ids.add(newThreadId());

  for (const id of ids) expect(id).toMatch(/^t\d+-[0-9a-f]{4}$/);
  // Uniqueness only has to hold within one session; 500 ids in the same
  // millisecond is far past what a real agent writes.
  expect(ids.size).toBeGreaterThan(495);
  expect(newThreadId(1_700_000_000_000).startsWith('t1700000000000-')).toBe(true);
});

test('--after resumes from the cursor a previous read returned', async () => {
  const dir = makeSessionDir();
  await appendFeedback(dir, { type: 'viewed', path: 'a.ts', viewed: true });
  await appendFeedback(dir, { type: 'viewed', path: 'b.ts', viewed: true });

  const first = await collectFeedback(dir);
  expect(first.timedOut).toBe(false);
  expect(first.batch.events).toHaveLength(2);
  expect(first.batch.nextLine).toBe(2);

  const nothingNew = await collectFeedback(dir, { after: first.batch.nextLine });
  expect(nothingNew.batch.events).toHaveLength(0);
  expect(nothingNew.batch.nextLine).toBe(2);

  await appendFeedback(dir, { type: 'verdict', stop: 's1', verdict: 'accepted' });
  const resumed = await collectFeedback(dir, { after: nothingNew.batch.nextLine });
  expect(resumed.batch.events).toHaveLength(1);
  expect(resumed.batch.events[0]?.type).toBe('verdict');
  expect(resumed.batch.nextLine).toBe(3);
});

test('a missing log reads as an empty batch, not an error', async () => {
  const dir = join(makeSessionDir(), 'not-created-yet');
  const { batch, timedOut } = await collectFeedback(dir);

  expect(batch).toEqual({ events: [], nextLine: 0, malformed: 0 });
  expect(timedOut).toBe(false);
});

test('--wait returns events appended while it blocks', async () => {
  const dir = makeSessionDir();
  await appendFeedback(dir, { type: 'viewed', path: 'a.ts', viewed: true });

  const pending = collectFeedback(dir, { after: 1, wait: true, timeoutMs: 3000 });
  await delay(60);
  await appendReply(dir, { thread: 't1', body: 'late arrival' });

  const { batch, timedOut } = await pending;
  expect(timedOut).toBe(false);
  expect(batch.events).toHaveLength(1);
  expect((batch.events[0] as ReplyEvent).body).toBe('late arrival');
  expect(batch.nextLine).toBe(2);
});

test('--wait that runs out of time reports an empty batch as timed out', async () => {
  const dir = makeSessionDir();
  await appendFeedback(dir, { type: 'viewed', path: 'a.ts', viewed: true });

  const { batch, timedOut } = await collectFeedback(dir, { after: 1, wait: true, timeoutMs: 40 });
  expect(timedOut).toBe(true);
  expect(batch.events).toHaveLength(0);
});

test('--wait honours an abort signal', async () => {
  const dir = makeSessionDir();
  const controller = new AbortController();
  const pending = collectFeedback(dir, {
    wait: true,
    timeoutMs: 5000,
    signal: controller.signal,
  });
  await delay(30);
  controller.abort();

  const { timedOut } = await pending;
  expect(timedOut).toBe(true);
});
