import { expect, test } from 'vitest';
import { pullComments } from './comments.ts';
import { toFeedbackEvents } from './feedback-map.ts';
import { COMMENTS_PAGED, fakeRunner, ok, PR_NUMBER, REPO_VIEW } from './test-fixtures.ts';
import type { RemoteComment } from './types.ts';

const remote = (over: Partial<RemoteComment> = {}): RemoteComment => ({
  remoteId: 5002,
  threadMarker: null,
  path: 'src/limit.ts',
  line: 42,
  side: 'RIGHT',
  body: 'bound this loop',
  author: 'octocat',
  createdAt: '2026-08-19T10:05:00Z',
  inReplyTo: null,
  url: 'https://github.com/octo/widget/pull/42#discussion_r5002',
  ...over,
});

test('a marked reply lands on its local thread', () => {
  const events = toFeedbackEvents([remote({ threadMarker: 't1', inReplyTo: 5001 })], new Set());

  expect(events).toEqual([
    {
      type: 'reply',
      ts: '2026-08-19T10:05:00Z',
      thread: 't1',
      body: 'bound this loop',
      author: 'human',
      origin: 'github',
      remote: { id: 5002, url: 'https://github.com/octo/widget/pull/42#discussion_r5002' },
    },
  ]);
});

test('a marker-less top-level comment becomes a comment with a stable id', () => {
  const events = toFeedbackEvents([remote()], new Set());

  expect(events).toEqual([
    {
      type: 'comment',
      ts: '2026-08-19T10:05:00Z',
      id: 'gh-5002',
      path: 'src/limit.ts',
      line: 42,
      side: 'head',
      body: 'bound this loop',
      author: 'human',
      origin: 'github',
      remote: { id: 5002, url: 'https://github.com/octo/widget/pull/42#discussion_r5002' },
    },
  ]);
  // Same input, same ids — a second pull can be compared against the first.
  expect(toFeedbackEvents([remote()], new Set())).toEqual(events);
});

test('a reply to a thread vsdiff does not know keeps the reviewer’s words', () => {
  const events = toFeedbackEvents([remote({ inReplyTo: 4711 })], new Set());

  expect(events[0]).toMatchObject({
    type: 'comment',
    id: 'gh-5002',
    body: '[github reply to comment #4711]\n\nbound this loop',
  });
});

test('LEFT maps to the base side, RIGHT and missing to head', () => {
  const [left, right, none] = toFeedbackEvents(
    [
      remote({ remoteId: 1, side: 'LEFT' }),
      remote({ remoteId: 2, side: 'RIGHT' }),
      remote({ remoteId: 3, side: null }),
    ],
    new Set(),
  );

  expect(left).toMatchObject({ side: 'base' });
  expect(right).toMatchObject({ side: 'head' });
  expect(none).toMatchObject({ side: 'head' });
});

test('a comment GitHub can no longer place lands on line 1', () => {
  const events = toFeedbackEvents([remote({ line: null })], new Set());

  expect(events[0]).toMatchObject({ line: 1, path: 'src/limit.ts' });
});

test('remote ids already imported are skipped', () => {
  const comments = [remote({ remoteId: 1 }), remote({ remoteId: 2 }), remote({ remoteId: 3 })];

  const events = toFeedbackEvents(comments, new Set([1, 3]));

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ id: 'gh-2' });
});

test('vsdiff’s own posted comment is not re-imported as a new thread', () => {
  const events = toFeedbackEvents([remote({ threadMarker: 't1', inReplyTo: null })], new Set());

  expect(events).toEqual([]);
});

test('the recorded PR maps end to end', async () => {
  const gh = fakeRunner({ 'repo view': ok(REPO_VIEW), 'pulls/42/comments': ok(COMMENTS_PAGED) });
  const comments = await pullComments('/repo', PR_NUMBER, { runGh: gh.run });

  const events = toFeedbackEvents(comments, new Set());

  // 5001 is vsdiff's own root (skipped); the rest all say something.
  expect(events).toEqual([
    {
      // A colleague's reply carries no marker; the parent's marker (5001 = the
      // vsdiff-posted root) resolves it onto the local thread. Live-validated
      // against a real PR on 2026-08-19.
      type: 'reply',
      ts: '2026-08-19T10:05:00Z',
      thread: 't1',
      body: 'good catch — bounding it at 5',
      author: 'human',
      origin: 'github',
      remote: { id: 5002, url: 'https://github.com/octo/widget/pull/42#discussion_r5002' },
    },
    {
      type: 'comment',
      ts: '2026-08-19T10:06:00Z',
      id: 'gh-5003',
      path: 'src/api/client.ts',
      line: 10,
      side: 'base',
      body: 'why drop the retry header here?',
      author: 'human',
      origin: 'github',
      remote: { id: 5003, url: 'https://github.com/octo/widget/pull/42#discussion_r5003' },
    },
    {
      type: 'comment',
      ts: '2026-08-19T10:07:00Z',
      id: 'gh-5004',
      path: 'README.md',
      line: 1,
      side: 'head',
      body: 'nit: stale sentence',
      author: 'human',
      origin: 'github',
      remote: { id: 5004, url: 'https://github.com/octo/widget/pull/42#discussion_r5004' },
    },
    {
      type: 'reply',
      ts: '2026-08-19T10:08:00Z',
      thread: 't1',
      body: 'addressed in 3c4d5e6',
      author: 'human',
      origin: 'github',
      remote: { id: 5005, url: 'https://github.com/octo/widget/pull/42#discussion_r5005' },
    },
    {
      type: 'comment',
      ts: '2026-08-19T10:09:00Z',
      id: 'gh-5006',
      path: 'src/limit.ts',
      line: 7,
      side: 'head',
      body: 'this moved, but it still reads oddly',
      author: 'human',
      origin: 'github',
      remote: { id: 5006, url: 'https://github.com/octo/widget/pull/42#discussion_r5006' },
    },
  ]);

  // Import, not sync: a second pull with the ids already known adds nothing.
  const known = new Set(events.map((event) => event.remote.id));
  expect(toFeedbackEvents(comments, known)).toEqual([]);
});
