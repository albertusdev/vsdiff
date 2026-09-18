import { expect, test } from 'vitest';
import { GhError } from './errors.ts';
import { checkoutPr, prSessionSource, resolvePr } from './pr.ts';
import {
  AUTH_FAILURE,
  BASE_SHA,
  fail,
  fakeRunner,
  GH_MISSING,
  HEAD_SHA,
  NO_BASE_REF_OID,
  NO_SUCH_PR,
  ok,
  PR_NUMBER,
  PR_REST,
  PR_REST_FORK,
  PR_VIEW,
  REPO_VIEW,
} from './test-fixtures.ts';

const PR_FIELDS =
  'number,title,url,baseRefName,headRefName,headRefOid,baseRefOid,isCrossRepository,state';
const PR_VIEW_ARGV = ['pr', 'view', '42', '--json', PR_FIELDS];

test('resolvePr maps gh JSON onto pinned SHAs', async () => {
  const gh = fakeRunner({ 'pr view': ok(PR_VIEW) });

  const pr = await resolvePr('/repo', PR_NUMBER, { runGh: gh.run });

  expect(gh.calls).toHaveLength(1);
  expect(gh.calls[0]?.args).toEqual(PR_VIEW_ARGV);
  expect(pr).toEqual({
    number: 42,
    title: 'Bound the token-bucket retry loop',
    url: 'https://github.com/octo/widget/pull/42',
    baseRefName: 'main',
    headRefName: 'agent/rate-limit',
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    isCrossRepository: false,
    state: 'OPEN',
  });
});

test('a gh too old for baseRefOid is answered from the REST endpoint', async () => {
  const gh = fakeRunner({
    'pr view': NO_BASE_REF_OID,
    'repo view': ok(REPO_VIEW),
    'api repos/octo/widget/pulls/42': ok(PR_REST),
  });

  const pr = await resolvePr('/repo', PR_NUMBER, { runGh: gh.run });

  expect(gh.lines()).toEqual([
    `pr view 42 --json ${PR_FIELDS}`,
    'repo view --json nameWithOwner',
    'api repos/octo/widget/pulls/42',
  ]);
  // Same contract either way — including the SHAs the guard depends on.
  expect(pr).toEqual({
    number: 42,
    title: 'Bound the token-bucket retry loop',
    url: 'https://github.com/octo/widget/pull/42',
    baseRefName: 'main',
    headRefName: 'agent/rate-limit',
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    isCrossRepository: false,
    state: 'OPEN',
  });
});

test('the REST fallback reads a merged fork PR the same way gh would', async () => {
  const gh = fakeRunner({
    'pr view': NO_BASE_REF_OID,
    'repo view': ok(REPO_VIEW),
    'api repos/octo/widget/pulls/42': ok(PR_REST_FORK),
  });

  const pr = await resolvePr('/repo', PR_NUMBER, { runGh: gh.run });

  expect(pr).toMatchObject({ isCrossRepository: true, state: 'MERGED', headSha: HEAD_SHA });
});

test('resolvePr on an unauthenticated gh says how to authenticate', async () => {
  const gh = fakeRunner({ 'pr view': AUTH_FAILURE });

  const error = await resolvePr('/repo', PR_NUMBER, { runGh: gh.run }).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(GhError);
  expect((error as GhError).kind).toBe('auth');
  expect((error as GhError).message).toContain('gh auth login');
});

test('resolvePr on a missing PR names the PR', async () => {
  const gh = fakeRunner({ 'pr view': NO_SUCH_PR });

  const error = await resolvePr('/repo', 999, { runGh: gh.run }).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(GhError);
  expect((error as GhError).kind).toBe('not-found');
  expect((error as GhError).message).toContain('pull request #999');
});

test('resolvePr without gh installed says to install it', async () => {
  const gh = fakeRunner({ 'pr view': GH_MISSING });

  const error = await resolvePr('/repo', PR_NUMBER, { runGh: gh.run }).catch((e: unknown) => e);

  expect((error as GhError).kind).toBe('gh-missing');
  expect((error as GhError).message).toContain('https://cli.github.com');
});

test('resolvePr refuses a PR JSON with no head sha — the guard depends on it', async () => {
  const gh = fakeRunner({ 'pr view': ok(JSON.stringify({ number: 42, baseRefOid: BASE_SHA })) });

  const error = await resolvePr('/repo', PR_NUMBER, { runGh: gh.run }).catch((e: unknown) => e);

  expect((error as GhError).kind).toBe('output');
  expect((error as GhError).message).toContain('headRefOid');
});

test('resolvePr rejects a nonsense PR number before it reaches argv', async () => {
  const gh = fakeRunner({});

  await expect(resolvePr('/repo', -1, { runGh: gh.run })).rejects.toThrow('positive integer');
  expect(gh.calls).toHaveLength(0);
});

test('checkoutPr checks the branch out and reads back the new HEAD', async () => {
  const gh = fakeRunner({ 'pr checkout': ok('') });
  const git = fakeRunner({ 'rev-parse': ok(`${HEAD_SHA}\n`) });

  const sha = await checkoutPr('/repo', PR_NUMBER, { runGh: gh.run, runGit: git.run });

  expect(sha).toBe(HEAD_SHA);
  expect(gh.calls[0]?.args).toEqual(['pr', 'checkout', '42']);
  expect(git.calls[0]?.args).toEqual(['rev-parse', 'HEAD']);
});

test('checkoutPr surfaces a failed checkout and never reads HEAD', async () => {
  const gh = fakeRunner({
    'pr checkout': fail(1, 'error: Your local changes would be overwritten by checkout.\n'),
  });
  const git = fakeRunner({});

  await expect(checkoutPr('/repo', PR_NUMBER, { runGh: gh.run, runGit: git.run })).rejects.toThrow(
    'local changes',
  );
  expect(git.calls).toHaveLength(0);
});

test('checkoutPr surfaces a git failure as a GitError', async () => {
  const gh = fakeRunner({ 'pr checkout': ok('') });
  const git = fakeRunner({ 'rev-parse': fail(128, 'fatal: not a git repository\n') });

  const error = await checkoutPr('/repo', PR_NUMBER, {
    runGh: gh.run,
    runGit: git.run,
  }).catch((e: unknown) => e);

  expect((error as Error).name).toBe('GitError');
});

test('prSessionSource pins SHAs, not ref names', () => {
  const source = prSessionSource({
    number: 42,
    title: 'Bound the token-bucket retry loop',
    url: 'https://github.com/octo/widget/pull/42',
    baseRefName: 'main',
    headRefName: 'agent/rate-limit',
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    isCrossRepository: false,
    state: 'OPEN',
  });

  expect(source).toEqual({ type: 'range', base: BASE_SHA, head: HEAD_SHA });
  expect(source.base).not.toBe('main');
  expect(source.head).not.toBe('agent/rate-limit');
});
