import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import type { FeedbackEvent } from './feedback-types.ts';
import {
  appendFeedback,
  buildThreads,
  readFeedback,
  readResult,
  summarizeVerdicts,
  waitForFeedback,
  writeResult,
} from './feedback.ts';

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.length = 0;
});

/** A real session dir on disk; `nested` exercises the mkdir-on-append path. */
function makeSessionDir(nested = false): string {
  const root = mkdtempSync(join(tmpdir(), 'vsdiff-feedback-'));
  tempRoots.push(root);
  return nested ? join(root, 'sessions', '2026-08-19-auth') : root;
}

const logPath = (dir: string): string => join(dir, 'feedback.jsonl');
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('append → read round trip preserves unknown types and extra fields', async () => {
  const dir = makeSessionDir(true);

  await appendFeedback(dir, {
    type: 'comment',
    ts: '2026-08-19T10:02:11Z',
    id: 't1',
    stop: 'refresh-race',
    path: 'src/auth/middleware.ts',
    line: 54,
    body: 'why not reuse the queue from api/client?',
    author: 'human',
  });
  await appendFeedback(dir, {
    type: 'posted',
    ts: '2026-08-19T10:03:00Z',
    thread: 't1',
    origin: 'github',
    remote: { reviewId: 9, commentId: 12, url: 'https://example.invalid/r/9' },
  } as FeedbackEvent);

  const batch = await readFeedback(dir);

  expect(batch.malformed).toBe(0);
  expect(batch.nextLine).toBe(2);
  expect(batch.events).toHaveLength(2);
  expect(batch.events[0]).toEqual({
    type: 'comment',
    ts: '2026-08-19T10:02:11Z',
    id: 't1',
    stop: 'refresh-race',
    path: 'src/auth/middleware.ts',
    line: 54,
    body: 'why not reuse the queue from api/client?',
    author: 'human',
  });
  const unknown = batch.events[1] as Record<string, unknown>;
  expect(unknown.type).toBe('posted');
  expect(unknown.origin).toBe('github');
  expect(unknown.remote).toEqual({
    reviewId: 9,
    commentId: 12,
    url: 'https://example.invalid/r/9',
  });
});

test('appendFeedback stamps ts when absent and keeps a supplied one', async () => {
  const dir = makeSessionDir();
  const before = Date.now();

  await appendFeedback(dir, { type: 'viewed', path: 'src/a.ts', viewed: true });
  await appendFeedback(dir, { type: 'done', ts: '2020-01-01T00:00:00.000Z', status: 'approved' });

  const { events } = await readFeedback(dir);
  const stamped = events[0]?.ts ?? '';
  expect(stamped).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  expect(Date.parse(stamped)).toBeGreaterThanOrEqual(before - 1000);
  expect(Date.parse(stamped)).toBeLessThanOrEqual(Date.now() + 1000);
  expect(events[1]?.ts).toBe('2020-01-01T00:00:00.000Z');
});

test('one event is one line, whatever its body contains', async () => {
  const dir = makeSessionDir();

  await appendFeedback(dir, {
    type: 'reply',
    thread: 't1',
    author: 'agent',
    body: 'line one\nline two\r\nand a "quote"',
  });

  const raw = await readFeedback(dir);
  expect(raw.nextLine).toBe(1);
  expect((raw.events[0] as Record<string, unknown>).body).toBe(
    'line one\nline two\r\nand a "quote"',
  );
});

test('appendFeedback rejects an event without a string type', async () => {
  const dir = makeSessionDir();

  await expect(
    appendFeedback(dir, { body: 'no type' } as unknown as FeedbackEvent),
  ).rejects.toThrow(/string `type`/);

  expect(await readFeedback(dir)).toEqual({ events: [], nextLine: 0, malformed: 0 });
});

test('afterLine resumes where the previous read stopped', async () => {
  const dir = makeSessionDir();
  await appendFeedback(dir, { type: 'comment', id: 't1', path: 'a.ts', line: 1, body: 'one' });
  await appendFeedback(dir, { type: 'comment', id: 't2', path: 'a.ts', line: 2, body: 'two' });

  const first = await readFeedback(dir);
  expect(first.events).toHaveLength(2);
  expect(first.nextLine).toBe(2);

  const idle = await readFeedback(dir, { afterLine: first.nextLine });
  expect(idle).toEqual({ events: [], nextLine: 2, malformed: 0 });

  await appendFeedback(dir, { type: 'verdict', stop: 's1', verdict: 'accepted' });
  const second = await readFeedback(dir, { afterLine: idle.nextLine });
  expect(second.events).toHaveLength(1);
  expect(second.events[0]?.type).toBe('verdict');
  expect(second.nextLine).toBe(3);
});

test('a malformed line is counted and skipped while its neighbours parse', async () => {
  const dir = makeSessionDir();
  await appendFeedback(dir, { type: 'comment', id: 't1', path: 'a.ts', line: 1, body: 'first' });
  appendFileSync(logPath(dir), '{"type":"comment","id":"t2"\n');
  appendFileSync(logPath(dir), 'not json at all\n');
  appendFileSync(logPath(dir), '["a","list"]\n');
  appendFileSync(logPath(dir), '{"noType":true}\n');
  await appendFeedback(dir, { type: 'reply', thread: 't1', author: 'agent', body: 'last' });

  const batch = await readFeedback(dir);

  expect(batch.events.map((event) => event.type)).toEqual(['comment', 'reply']);
  expect(batch.malformed).toBe(4);
  expect(batch.nextLine).toBe(6);
});

test('a trailing partial line is not consumed until the writer finishes it', async () => {
  const dir = makeSessionDir();
  await appendFeedback(dir, { type: 'comment', id: 't1', path: 'a.ts', line: 1, body: 'done' });
  appendFileSync(logPath(dir), '{"type":"reply","thread":"t1","author":"agent"');

  const torn = await readFeedback(dir);
  expect(torn.events).toHaveLength(1);
  expect(torn.nextLine).toBe(1);
  expect(torn.malformed).toBe(0);

  appendFileSync(logPath(dir), ',"body":"finished","ts":"2026-08-19T10:00:00Z"}\n');

  const resumed = await readFeedback(dir, { afterLine: torn.nextLine });
  expect(resumed.malformed).toBe(0);
  expect(resumed.nextLine).toBe(2);
  expect(resumed.events).toHaveLength(1);
  expect((resumed.events[0] as Record<string, unknown>).body).toBe('finished');
});

test('concurrent appends from separate handles keep one event per line', async () => {
  const dir = makeSessionDir();
  // Bodies grow past the page size: interleaved writes would show up as
  // malformed lines rather than 16 clean ones.
  const bodies = Array.from({ length: 16 }, (_, i) => `body-${i}-${'x'.repeat(i * 512)}`);

  await Promise.all(
    bodies.map((body) =>
      appendFeedback(dir, { type: 'reply', thread: 't1', author: 'agent', body }),
    ),
  );

  const batch = await readFeedback(dir);
  expect(batch.malformed).toBe(0);
  expect(batch.nextLine).toBe(16);
  expect(batch.events).toHaveLength(16);
  expect(new Set(batch.events.map((e) => (e as Record<string, unknown>).body))).toEqual(
    new Set(bodies),
  );
});

test('readFeedback on a missing log is an empty batch', async () => {
  const dir = makeSessionDir(true);
  expect(await readFeedback(dir)).toEqual({ events: [], nextLine: 0, malformed: 0 });
  expect(await readFeedback(dir, { afterLine: 7 })).toEqual({
    events: [],
    nextLine: 0,
    malformed: 0,
  });
});

test('waitForFeedback returns at once when events already sit past afterLine', async () => {
  const dir = makeSessionDir();
  await appendFeedback(dir, { type: 'comment', id: 't1', path: 'a.ts', line: 1, body: 'one' });
  await appendFeedback(dir, { type: 'verdict', stop: 's1', verdict: 'needs-work' });

  const batch = await waitForFeedback(dir, { afterLine: 1, timeoutMs: 5_000 });

  expect(batch.events).toHaveLength(1);
  expect(batch.events[0]?.type).toBe('verdict');
  expect(batch.nextLine).toBe(2);
});

test('waitForFeedback wakes on an event appended after the call', async () => {
  // Existing dir, log not created yet: the watcher is on the dir, so it sees
  // the log appear. The nested dir doesn't exist at all, so fs.watch can't be
  // installed and the 500ms poll is the only way this resolves.
  for (const dir of [makeSessionDir(), makeSessionDir(true)]) {
    const started = Date.now();
    const waiting = waitForFeedback(dir, { afterLine: 0, timeoutMs: 4_000 });
    await delay(50);
    await appendFeedback(dir, { type: 'comment', id: 't1', path: 'a.ts', line: 1, body: 'late' });
    const batch = await waiting;

    expect(batch.events).toHaveLength(1);
    expect((batch.events[0] as Record<string, unknown>).body).toBe('late');
    expect(batch.nextLine).toBe(1);
    expect(Date.now() - started).toBeLessThan(3_000);
  }
});

test('waitForFeedback times out clean when nothing arrives', async () => {
  const dir = makeSessionDir(true);
  const started = Date.now();

  const batch = await waitForFeedback(dir, { afterLine: 0, timeoutMs: 400 });

  expect(batch).toEqual({ events: [], nextLine: 0, malformed: 0 });
  expect(Date.now() - started).toBeGreaterThanOrEqual(350);
});

test('waitForFeedback resolves on abort with whatever is there', async () => {
  const dir = makeSessionDir();
  const controller = new AbortController();
  const started = Date.now();

  const waiting = waitForFeedback(dir, {
    afterLine: 0,
    timeoutMs: 30_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  const batch = await waiting;

  expect(batch.events).toEqual([]);
  expect(Date.now() - started).toBeLessThan(3_000);

  const preAborted = new AbortController();
  preAborted.abort();
  await appendFeedback(dir, { type: 'comment', id: 't1', path: 'a.ts', line: 1, body: 'x' });
  const after = await waitForFeedback(dir, {
    afterLine: 0,
    timeoutMs: 30_000,
    signal: preAborted.signal,
  });
  expect(after.events).toHaveLength(1);
});

const comment = (id: string, extra: Record<string, unknown> = {}): FeedbackEvent =>
  ({
    type: 'comment',
    ts: '2026-08-19T10:00:00Z',
    id,
    path: 'src/a.ts',
    line: 1,
    body: `body ${id}`,
    author: 'human',
    ...extra,
  }) as FeedbackEvent;

test('buildThreads attaches replies in order and drops replies to unknown threads', () => {
  const threads = buildThreads([
    comment('t1'),
    { type: 'reply', ts: '1', thread: 't1', author: 'agent', body: 'first' },
    comment('t2'),
    { type: 'reply', ts: '2', thread: 't9', author: 'agent', body: 'orphan' },
    { type: 'reply', ts: '3', thread: 't1', author: 'human', body: 'second' },
    { type: 'viewed', ts: '4', path: 'src/a.ts', viewed: true },
  ]);

  expect(threads.map((t) => t.id)).toEqual(['t1', 't2']);
  expect(threads[0]?.replies.map((r) => r.body)).toEqual(['first', 'second']);
  expect(threads[0]?.root.body).toBe('body t1');
  expect(threads[1]?.replies).toEqual([]);
  expect(threads.every((t) => t.resolved === false)).toBe(true);
});

test('buildThreads: last resolve wins, resolved stays resolved, unknown by is dropped', () => {
  const threads = buildThreads([
    comment('t1'),
    comment('t2'),
    comment('t3'),
    { type: 'resolve', ts: '1', thread: 't1', by: 'agent' },
    { type: 'resolve', ts: '2', thread: 't1', by: 'human' },
    { type: 'resolve', ts: '3', thread: 't2', by: 'agent' },
    { type: 'reply', ts: '4', thread: 't2', author: 'human', body: 'still resolved after a reply' },
    { type: 'resolve', ts: '5', thread: 't3', by: 'nobody' } as unknown as FeedbackEvent,
    { type: 'resolve', ts: '6', thread: 't9', by: 'agent' },
  ]);

  const byId = new Map(threads.map((t) => [t.id, t]));
  expect(byId.get('t1')).toMatchObject({ resolved: true, resolvedBy: 'human' });
  expect(byId.get('t2')?.resolved).toBe(true);
  expect(byId.get('t2')?.replies).toHaveLength(1);
  expect(byId.get('t3')?.resolved).toBe(true);
  expect(byId.get('t3')?.resolvedBy).toBeUndefined();
  expect(threads).toHaveLength(3);
});

test('buildThreads keeps the first thread opened under a repeated id', () => {
  const threads = buildThreads([
    comment('t1', { body: 'original' }),
    { type: 'reply', ts: '1', thread: 't1', author: 'agent', body: 'reply' },
    comment('t1', { body: 'duplicate' }),
    comment('', { body: 'no id' }),
  ]);

  expect(threads).toHaveLength(1);
  expect(threads[0]?.root.body).toBe('original');
  expect(threads[0]?.replies).toHaveLength(1);
});

test('summarizeVerdicts counts the last verdict per stop', () => {
  const verdicts = summarizeVerdicts([
    { type: 'verdict', ts: '1', stop: 's1', verdict: 'needs-work' },
    { type: 'verdict', ts: '2', stop: 's1', verdict: 'accepted' },
    { type: 'verdict', ts: '3', stop: 's2', verdict: 'accepted' },
    { type: 'verdict', ts: '4', stop: 's3', verdict: 'question' },
    { type: 'verdict', ts: '5', stop: 's4', verdict: 'accepted' },
    { type: 'verdict', ts: '6', stop: 's4', verdict: 'later-kind' } as unknown as FeedbackEvent,
    { type: 'verdict', ts: '7', verdict: 'accepted' } as unknown as FeedbackEvent,
    { type: 'comment', ts: '8', id: 't1', path: 'a.ts', line: 1, body: 'x', author: 'human' },
  ]);

  expect(verdicts).toEqual({ accepted: 2, needsWork: 0, questions: 1 });
  expect(summarizeVerdicts([])).toEqual({ accepted: 0, needsWork: 0, questions: 0 });
});

test('the log folds into the --await result document', async () => {
  const dir = makeSessionDir(true);
  await appendFeedback(dir, { type: 'comment', id: 't1', path: 'a.ts', line: 1, body: 'q' });
  await appendFeedback(dir, { type: 'comment', id: 't2', path: 'a.ts', line: 9, body: 'q2' });
  await appendFeedback(dir, { type: 'resolve', thread: 't2', by: 'agent' });
  await appendFeedback(dir, { type: 'verdict', stop: 's1', verdict: 'needs-work' });

  const { events } = await readFeedback(dir);
  const result = {
    status: 'changes-requested' as const,
    verdicts: summarizeVerdicts(events),
    openThreads: buildThreads(events)
      .filter((t) => !t.resolved)
      .map((t) => t.id),
    finishedAt: '2026-08-19T11:00:00Z',
  };
  await writeResult(dir, result);

  expect(await readResult(dir)).toEqual(result);
  expect(result.openThreads).toEqual(['t1']);
  expect(result.verdicts).toEqual({ accepted: 0, needsWork: 1, questions: 0 });
});

test('writeResult replaces an earlier result and leaves no tmp behind', async () => {
  const dir = makeSessionDir();
  await writeResult(dir, {
    status: 'canceled',
    verdicts: { accepted: 0, needsWork: 0, questions: 0 },
    openThreads: [],
    finishedAt: '2026-08-19T10:00:00Z',
  });
  await writeResult(dir, {
    status: 'approved',
    verdicts: { accepted: 9, needsWork: 2, questions: 1 },
    openThreads: ['t1', 't4'],
    note: 'ship it',
    finishedAt: '2026-08-19T12:00:00Z',
  });

  const result = await readResult(dir);
  expect(result?.status).toBe('approved');
  expect(result?.openThreads).toEqual(['t1', 't4']);
  expect(result?.note).toBe('ship it');
  expect(existsSync(join(dir, 'result.json.tmp'))).toBe(false);
});

test('readResult is null when missing and on garbage', async () => {
  const dir = makeSessionDir();
  expect(await readResult(dir)).toBeNull();
  expect(await readResult(join(dir, 'nowhere'))).toBeNull();

  writeFileSync(join(dir, 'result.json'), '{ "status": "approved" ');
  expect(await readResult(dir)).toBeNull();

  writeFileSync(join(dir, 'result.json'), '"approved"');
  expect(await readResult(dir)).toBeNull();
});
