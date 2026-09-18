import { expect, test } from 'vitest';
import type { FeedbackBatch, FeedbackEvent } from '@vsdiff/core';
import { formatBatch, formatEvent, summarizeBody } from './format.ts';

const TS = '2026-08-19T10:02:11Z';

test('comment renders path:line and the first 80 chars of the body', () => {
  const line = formatEvent({
    type: 'comment',
    ts: TS,
    id: 't1',
    path: 'src/auth/middleware.ts',
    line: 54,
    body: 'why not reuse the queue from api/client?',
    author: 'human',
  });

  expect(line).toBe(
    `[${TS}] comment · src/auth/middleware.ts:54 — why not reuse the queue from api/client?`,
  );
});

test('comment shows its stop and a base-side anchor', () => {
  const line = formatEvent({
    type: 'comment',
    ts: TS,
    id: 't2',
    stop: 'refresh-race',
    path: 'src/a.ts',
    line: 7,
    side: 'base',
    body: 'gone in head',
    author: 'human',
  });

  expect(line).toBe(`[${TS}] comment · src/a.ts:7 (base) [refresh-race] — gone in head`);
});

test('long bodies truncate at 80 chars and newlines collapse to one line', () => {
  expect(summarizeBody(`${'x'.repeat(90)}`)).toBe(`${'x'.repeat(80)}…`);
  expect(summarizeBody('two\n\nlines  here')).toBe('two lines here');
  expect(summarizeBody(undefined)).toBe('');

  const line = formatEvent({
    type: 'reply',
    ts: TS,
    thread: 't1',
    body: `first line\nsecond line ${'y'.repeat(90)}`,
    author: 'agent',
  });
  expect(line.endsWith('…')).toBe(true);
  expect(line.split('\n')).toHaveLength(1);
});

test('reply, verdict, viewed, resolve and done each render their own summary', () => {
  expect(
    formatEvent({
      type: 'reply',
      ts: TS,
      thread: 't1',
      body: 'unified in 3f2a1c9',
      author: 'agent',
    }),
  ).toBe(`[${TS}] reply · → t1 — unified in 3f2a1c9`);

  expect(
    formatEvent({ type: 'verdict', ts: TS, stop: 'refresh-race', verdict: 'needs-work' }),
  ).toBe(`[${TS}] verdict · refresh-race → needs-work`);

  expect(formatEvent({ type: 'viewed', ts: TS, path: 'src/a.ts', viewed: true })).toBe(
    `[${TS}] viewed · src/a.ts — viewed`,
  );
  expect(formatEvent({ type: 'viewed', ts: TS, path: 'src/a.ts', viewed: false })).toBe(
    `[${TS}] viewed · src/a.ts — not viewed`,
  );

  expect(formatEvent({ type: 'resolve', ts: TS, thread: 't4', by: 'human' })).toBe(
    `[${TS}] resolve · → t4 — resolved by human`,
  );

  expect(formatEvent({ type: 'done', ts: TS, status: 'changes-requested', note: 'see t1' })).toBe(
    `[${TS}] done · changes-requested — see t1`,
  );
  expect(formatEvent({ type: 'done', ts: TS, status: 'approved' })).toBe(`[${TS}] done · approved`);
});

test('unknown event types stay visible with their payload', () => {
  const event = {
    type: 'posted',
    ts: TS,
    thread: 't1',
    origin: 'github',
  } as unknown as FeedbackEvent;

  expect(formatEvent(event)).toBe(`[${TS}] posted · {"thread":"t1","origin":"github"}`);
});

test('missing fields degrade to ? instead of throwing', () => {
  const event = { type: 'verdict' } as unknown as FeedbackEvent;
  expect(formatEvent(event)).toBe('[?] verdict · ? → ?');
});

test('the batch ends with the resume cursor', () => {
  const batch: FeedbackBatch = {
    events: [{ type: 'verdict', ts: TS, stop: 's1', verdict: 'accepted' }],
    nextLine: 7,
    malformed: 0,
  };

  expect(formatBatch(batch)).toBe(`[${TS}] verdict · s1 → accepted\nnext: --after 7\n`);
});

test('an empty batch says so, and malformed lines are reported', () => {
  expect(formatBatch({ events: [], nextLine: 0, malformed: 0 })).toBe(
    'no new feedback\nnext: --after 0\n',
  );
  expect(formatBatch({ events: [], nextLine: 3, malformed: 2 })).toBe(
    'no new feedback\nnote: skipped 2 malformed line(s)\nnext: --after 3\n',
  );
});
