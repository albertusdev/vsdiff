// PR sourcing: resolve a number into the SHAs a session pins itself to, and
// check the branch out. Both are read-only against GitHub — `gh pr checkout`
// only writes to the local checkout.

import { GitError } from '@vsdiff/core';
import type { SessionSource } from '@vsdiff/schema';
import { ghError, outputError } from './errors.ts';
import { isRecord, num, parseJsonObject, str } from './json.ts';
import { nameWithOwner } from './repo.ts';
import { makeRunGh, makeRunGit, requirePrNumber } from './run.ts';
import type { GhDeps, PullRequest, RunGh } from './types.ts';

/** Exactly the fields `PullRequest` is built from — nothing spare to parse. */
const PR_FIELDS =
  'number,title,url,baseRefName,headRefName,headRefOid,baseRefOid,isCrossRepository,state';

/**
 * `baseRefOid` is a recent gh field — 2.46 (a version still common in the wild) rejects it
 * client-side, before any request. Rather than refuse those installs, fall back
 * to the REST endpoint, which has always carried `base.sha`.
 */
const NO_BASE_REF_OID = /unknown json field: "?baseRefOid/i;

const SHA = /^[0-9a-f]{7,64}$/i;

function requireSha(args: string[], value: unknown, field: string): string {
  const sha = str(value);
  // Without both SHAs there is no head-moved guard and no pinned range — the
  // whole point of resolving a PR — so this is fatal, not a default.
  if (!SHA.test(sha)) throw outputError(args, `${field} (a commit sha)`, String(value));
  return sha;
}

export async function resolvePr(
  repoRoot: string,
  prNumber: number,
  deps: GhDeps = {},
): Promise<PullRequest> {
  const number = requirePrNumber(prNumber);
  const runGh = deps.runGh ?? makeRunGh(repoRoot);
  const args = ['pr', 'view', String(number), '--json', PR_FIELDS];
  const run = await runGh(args);
  if (run.code !== 0) {
    if (NO_BASE_REF_OID.test(`${run.stderr}\n${run.stdout}`)) return prViaApi(runGh, number);
    throw ghError(args, run, `pull request #${number}`);
  }

  const raw = parseJsonObject(args, 'pull request JSON', run.stdout);
  return {
    number: num(raw.number) ?? number,
    title: str(raw.title),
    url: str(raw.url),
    baseRefName: str(raw.baseRefName),
    headRefName: str(raw.headRefName),
    baseSha: requireSha(args, raw.baseRefOid, 'baseRefOid'),
    headSha: requireSha(args, raw.headRefOid, 'headRefOid'),
    isCrossRepository: raw.isCrossRepository === true,
    state: str(raw.state),
  };
}

/** The same PR, read from REST — the shape an older gh can still answer. */
async function prViaApi(runGh: RunGh, number: number): Promise<PullRequest> {
  const slug = await nameWithOwner(runGh);
  const args = ['api', `repos/${slug}/pulls/${number}`];
  const run = await runGh(args);
  if (run.code !== 0) throw ghError(args, run, `pull request #${number}`);

  const raw = parseJsonObject(args, 'pull request JSON', run.stdout);
  const base = isRecord(raw.base) ? raw.base : {};
  const head = isRecord(raw.head) ? raw.head : {};
  const baseRepo = isRecord(base.repo) ? str(base.repo.full_name) : '';
  // A fork whose repo is gone reads as cross-repository, which it was.
  const headRepo = isRecord(head.repo) ? str(head.repo.full_name) : '';
  return {
    number: num(raw.number) ?? number,
    title: str(raw.title),
    url: str(raw.html_url),
    baseRefName: str(base.ref),
    headRefName: str(head.ref),
    baseSha: requireSha(args, base.sha, 'base.sha'),
    headSha: requireSha(args, head.sha, 'head.sha'),
    isCrossRepository: headRepo !== baseRepo,
    // REST says "open"/"closed" and flags merges separately; `gh pr view` says
    // OPEN/CLOSED/MERGED. Callers see the one vocabulary.
    state: raw.merged === true ? 'MERGED' : str(raw.state).toUpperCase(),
  };
}

/** Checks the PR branch out and returns the HEAD it left the checkout on. */
export async function checkoutPr(
  repoRoot: string,
  prNumber: number,
  deps: GhDeps = {},
): Promise<string> {
  const number = requirePrNumber(prNumber);
  const runGh = deps.runGh ?? makeRunGh(repoRoot);
  const runGit = deps.runGit ?? makeRunGit(repoRoot);

  const args = ['pr', 'checkout', String(number)];
  const run = await runGh(args);
  if (run.code !== 0) throw ghError(args, run, `pull request #${number}`);

  const revArgs = ['rev-parse', 'HEAD'];
  const rev = await runGit(revArgs);
  if (rev.code !== 0) throw new GitError(revArgs, rev.code, rev.stderr);
  const sha = rev.stdout.trim();
  if (!SHA.test(sha)) throw new GitError(revArgs, rev.code, `HEAD is not a commit: '${sha}'`);
  return sha;
}

/**
 * The session source for reviewing a PR: a range pinned to SHAs, never ref
 * names. `git diff base...head` then means what GitHub means, and the session
 * still describes the same change after either branch moves — which is what the
 * head-moved guard (D5) compares against at publish time.
 */
export function prSessionSource(pr: PullRequest): SessionSource {
  return { type: 'range', base: pr.baseSha, head: pr.headSha };
}
