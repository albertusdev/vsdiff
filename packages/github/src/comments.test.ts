import { expect, test } from 'vitest';
import { normalizeComment, pullComments } from './comments.ts';
import type { GhError } from './errors.ts';
import {
  COMMENTS_PAGE_1,
  COMMENTS_PAGE_2,
  COMMENTS_PAGED,
  fail,
  fakeRunner,
  HEAD_SHA,
  ok,
  PR_NUMBER,
  REPO_VIEW,
} from './test-fixtures.ts';

const runner = () =>
  fakeRunner({
    'repo view': ok(REPO_VIEW),
    'pulls/42/comments': ok(COMMENTS_PAGED),
  });

test('pullComments merges every page gh --paginate emits', async () => {
  const gh = runner();

  const comments = await pullComments('/repo', PR_NUMBER, { runGh: gh.run });

  expect(gh.lines()).toEqual([
    'repo view --json nameWithOwner',
    'api repos/octo/widget/pulls/42/comments --paginate',
  ]);
  // Two concatenated JSON arrays, not one — 2 comments then 4.
  expect(comments.map((c) => c.remoteId)).toEqual([5001, 5002, 5003, 5004, 5005, 5006]);
});

test('pullComments parses the vsdiff marker and strips its line from the body', async () => {
  const gh = runner();

  const comments = await pullComments('/repo', PR_NUMBER, { runGh: gh.run });

  expect(comments[0]).toEqual({
    remoteId: 5001,
    threadMarker: 't1',
    path: 'src/limit.ts',
    line: 42,
    side: 'RIGHT',
    body: 'this retry loop can spin forever',
    author: 'example-reviewer',
    createdAt: '2026-08-19T10:00:00Z',
    inReplyTo: null,
    url: 'https://github.com/octo/widget/pull/42#discussion_r5001',
  });
  expect(comments[0]?.body).not.toContain('vsdiff:');
});

test('pullComments normalises replies, sides and unplaceable lines', async () => {
  const gh = runner();

  const [, reply, left, unplaced, marked, outdated] = await pullComments('/repo', PR_NUMBER, {
    runGh: gh.run,
  });

  expect(reply).toMatchObject({ remoteId: 5002, threadMarker: null, inReplyTo: 5001 });
  expect(left).toMatchObject({ remoteId: 5003, side: 'LEFT', line: 10 });
  // No line and no original line: GitHub cannot place it any more.
  expect(unplaced).toMatchObject({ remoteId: 5004, line: null, side: null });
  expect(marked).toMatchObject({ remoteId: 5005, threadMarker: 't1', inReplyTo: 5001 });
  expect(marked?.body).toBe('addressed in 3c4d5e6');
  // Outdated but still anchored: the original line is where the reviewer looked.
  expect(outdated).toMatchObject({ remoteId: 5006, line: 7 });
});

test('a single-page response still parses', async () => {
  const gh = fakeRunner({
    'repo view': ok(REPO_VIEW),
    'pulls/42/comments': ok(COMMENTS_PAGE_1),
  });

  const comments = await pullComments('/repo', PR_NUMBER, { runGh: gh.run });

  expect(comments).toHaveLength(2);
});

test('an empty PR yields no comments', async () => {
  const gh = fakeRunner({ 'repo view': ok(REPO_VIEW), 'pulls/42/comments': ok('[]\n') });

  expect(await pullComments('/repo', PR_NUMBER, { runGh: gh.run })).toEqual([]);
});

test('a review-body marker never becomes a thread id', () => {
  const comment = normalizeComment({
    id: 900,
    body: `<!-- vsdiff:review:${HEAD_SHA} -->\nlooks good overall`,
    path: 'src/limit.ts',
    line: 3,
  });

  expect(comment?.threadMarker).toBeNull();
  expect(comment?.body).toBe('looks good overall');
});

test('entries that are not review comments are dropped, not guessed at', () => {
  expect(normalizeComment(null)).toBeNull();
  expect(normalizeComment({ body: 'no id' })).toBeNull();
  expect(normalizeComment({ id: 7 })).toMatchObject({ remoteId: 7, path: '', author: 'unknown' });
});

test('a 404 from the comments endpoint is actionable', async () => {
  const gh = fakeRunner({
    'repo view': ok(REPO_VIEW),
    'pulls/42/comments': fail(1, 'gh: Not Found (HTTP 404)\n'),
  });

  const error = await pullComments('/repo', PR_NUMBER, { runGh: gh.run }).catch((e: unknown) => e);

  expect((error as GhError).kind).toBe('not-found');
  expect((error as GhError).message).toContain('pull request #42');
});

test('a checkout with no GitHub remote fails before any API call', async () => {
  const gh = fakeRunner({
    'repo view': fail(
      1,
      'none of the git remotes configured for this repository point to a known GitHub host\n',
    ),
  });

  const error = await pullComments('/repo', PR_NUMBER, { runGh: gh.run }).catch((e: unknown) => e);

  expect((error as GhError).kind).toBe('no-repo');
  expect(gh.calls).toHaveLength(1);
});

test('the second page is what carries the marked reply', () => {
  // Guards the fixture itself: the pagination test above is only meaningful
  // while these really are two separate pages.
  expect(COMMENTS_PAGE_2).toContain('vsdiff:t1');
  expect(COMMENTS_PAGED).toBe(`${COMMENTS_PAGE_1}\n${COMMENTS_PAGE_2}\n`);
});
