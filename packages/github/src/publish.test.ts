import { expect, test } from 'vitest';
import { CommentRejectedError, GhError, HeadMovedError } from './errors.ts';
import { publishReview } from './publish.ts';
import {
  COMMENTS_PAGED,
  fail,
  fakeRunner,
  HEAD_SHA,
  headOid,
  MOVED_SHA,
  ok,
  PR_NUMBER,
  REPO_VIEW,
  REVIEW_422,
  REVIEW_422_NAMED,
  REVIEW_CREATED,
  type RecordedCall,
  type Reply,
} from './test-fixtures.ts';
import type { PublishOptions, PublishThread } from './types.ts';

/** The JSON that was piped to `gh api --input -`. */
const payload = (call: RecordedCall | undefined): Record<string, unknown> =>
  JSON.parse(call?.stdin ?? '{}') as Record<string, unknown>;

const T2: PublishThread = {
  id: 't2',
  path: 'src/api/client.ts',
  line: 10,
  side: 'LEFT',
  body: 'this drops the retry header',
};
const T3: PublishThread = {
  id: 't3',
  path: 'src/limit.ts',
  line: 42,
  side: 'RIGHT',
  body: 'bound this loop',
};
/** `t1` is already on the PR in the recorded comments. */
const T1: PublishThread = { ...T3, id: 't1', body: 'this retry loop can spin forever' };

const options = (over: Partial<PublishOptions> = {}): PublishOptions => ({
  prNumber: PR_NUMBER,
  headSha: HEAD_SHA,
  event: 'REQUEST_CHANGES',
  body: '2 things before this lands.',
  threads: [T1, T2, T3],
  ...over,
});

const runner = (over: Record<string, Reply> = {}) =>
  fakeRunner({
    '--json headRefOid': ok(headOid(HEAD_SHA)),
    'repo view': ok(REPO_VIEW),
    'pulls/42/comments': ok(COMMENTS_PAGED),
    'pulls/42/reviews': ok(REVIEW_CREATED),
    ...over,
  });

test('the head guard refuses before anything else runs', async () => {
  const gh = runner({ '--json headRefOid': ok(headOid(MOVED_SHA)) });

  const error = await publishReview('/repo', options(), { runGh: gh.run }).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(HeadMovedError);
  expect((error as HeadMovedError).expected).toBe(HEAD_SHA);
  expect((error as HeadMovedError).actual).toBe(MOVED_SHA);
  expect((error as HeadMovedError).prNumber).toBe(42);
  // Nothing was read or written past the guard.
  expect(gh.lines()).toEqual(['pr view 42 --json headRefOid']);
});

test('publishes one review with marker-prefixed bodies and the exact payload', async () => {
  const gh = runner();

  const result = await publishReview('/repo', options(), { runGh: gh.run });

  expect(gh.lines()).toEqual([
    'pr view 42 --json headRefOid',
    'repo view --json nameWithOwner',
    'api repos/octo/widget/pulls/42/comments --paginate',
    'api repos/octo/widget/pulls/42/reviews --method POST --input -',
  ]);

  const post = gh.calls[3];
  expect(post?.args).toEqual([
    'api',
    'repos/octo/widget/pulls/42/reviews',
    '--method',
    'POST',
    '--input',
    '-',
  ]);
  expect(payload(post)).toEqual({
    commit_id: HEAD_SHA,
    event: 'REQUEST_CHANGES',
    body: `<!-- vsdiff:review:${HEAD_SHA} -->\n2 things before this lands.`,
    comments: [
      {
        path: 'src/api/client.ts',
        line: 10,
        side: 'LEFT',
        body: '<!-- vsdiff:t2 -->\nthis drops the retry header',
      },
      {
        path: 'src/limit.ts',
        line: 42,
        side: 'RIGHT',
        body: '<!-- vsdiff:t3 -->\nbound this loop',
      },
    ],
  });

  expect(result).toEqual({
    posted: [
      { id: 't2', path: 'src/api/client.ts', line: 10 },
      { id: 't3', path: 'src/limit.ts', line: 42 },
    ],
    skipped: ['t1'],
    reviewUrl: 'https://github.com/octo/widget/pull/42#pullrequestreview-77001',
    reviewId: 77001,
  });
});

test('a thread whose marker is already on the PR is skipped, not posted twice', async () => {
  const gh = runner();

  const result = await publishReview('/repo', options({ threads: [T1] }), { runGh: gh.run });

  expect(result.skipped).toEqual(['t1']);
  expect(result.posted).toEqual([]);
  // Body only — the review still carries the summary, with no comments.
  expect(payload(gh.calls[3]).comments).toEqual([]);
});

test('a duplicate thread id inside one batch posts once', async () => {
  const gh = runner();

  const result = await publishReview('/repo', options({ threads: [T2, { ...T2 }] }), {
    runGh: gh.run,
  });

  expect(result.posted).toEqual([{ id: 't2', path: 'src/api/client.ts', line: 10 }]);
  expect(result.skipped).toEqual(['t2']);
  expect(payload(gh.calls[3]).comments).toHaveLength(1);
});

test('nothing left to say posts nothing at all', async () => {
  const gh = runner();

  const result = await publishReview(
    '/repo',
    options({ event: 'COMMENT', body: '  ', threads: [T1] }),
    {
      runGh: gh.run,
    },
  );

  expect(result).toEqual({ posted: [], skipped: ['t1'] });
  expect(gh.lines()).not.toContain(
    'api repos/octo/widget/pulls/42/reviews --method POST --input -',
  );
});

test('a 422 names every comment in the rejected review and never retries', async () => {
  const gh = runner({ 'pulls/42/reviews': REVIEW_422 });

  const error = await publishReview('/repo', options(), { runGh: gh.run }).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(CommentRejectedError);
  const rejected = error as CommentRejectedError;
  expect(rejected.status).toBe(422);
  expect(rejected.attempted).toEqual([
    { id: 't2', path: 'src/api/client.ts', line: 10 },
    { id: 't3', path: 'src/limit.ts', line: 42 },
  ]);
  // GitHub named no file, so the whole review needs re-anchoring.
  expect(rejected.rejected).toHaveLength(2);
  expect(rejected.messages).toContain('pull_request_review_thread.line must be part of the diff');
  expect(rejected.message).toContain('src/api/client.ts:10 (t2)');
  expect(rejected.message).toContain('src/limit.ts:42 (t3)');
  expect(rejected.message).toContain('nothing was posted');
  // One POST, no blind retry — idempotency depends on it.
  expect(gh.lines().filter((line) => line.includes('/reviews'))).toHaveLength(1);
});

test('a 422 that names a file singles that comment out, with the reason', async () => {
  const gh = runner({ 'pulls/42/reviews': REVIEW_422_NAMED });

  const error = (await publishReview('/repo', options(), { runGh: gh.run }).catch(
    (e: unknown) => e,
  )) as CommentRejectedError;

  expect(error.rejected).toEqual([
    {
      id: 't2',
      path: 'src/api/client.ts',
      line: 10,
      reason: 'src/api/client.ts: line must be part of the diff',
    },
  ]);
  expect(error.attempted).toHaveLength(2);
});

test('a non-422 failure stays a plain gh error', async () => {
  const gh = runner({
    'pulls/42/reviews': fail(
      1,
      'gh: Resource not accessible by personal access token (HTTP 403)\n',
    ),
  });

  const error = await publishReview('/repo', options(), { runGh: gh.run }).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(GhError);
  expect(error).not.toBeInstanceOf(CommentRejectedError);
  expect((error as GhError).message).toContain('HTTP 403');
});
