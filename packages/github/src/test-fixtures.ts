// Recorded `gh` output and the fake runners every test in this package drives.
// No test here shells out to gh or touches the network: a route table maps an
// argv substring to a canned run, and an unrouted call is a test failure, which
// is also how the tests assert that nothing calls gh behind their back.

import type { GhRun, RunGh, RunGit } from './types.ts';

export const SLUG = 'octo/widget';
export const PR_NUMBER = 42;
export const HEAD_SHA = '9f2c1ab5d4e6f7089a1b2c3d4e5f60718293a4b5';
export const BASE_SHA = '1a2b3c4d5e6f708192a3b4c5d6e7f80912a3b4c5';
export const MOVED_SHA = 'aa11bb22cc33dd44ee55ff6677889900aabbccdd';

export const ok = (stdout: string, stderr = ''): GhRun => ({ code: 0, stdout, stderr });
export const fail = (code: number, stderr: string, stdout = ''): GhRun => ({
  code,
  stdout,
  stderr,
});

export interface RecordedCall {
  args: string[];
  stdin: string | undefined;
}

export type Reply = GhRun | ((args: string[], stdin?: string) => GhRun);

export interface FakeRunner {
  run: RunGh & RunGit;
  calls: RecordedCall[];
  /** `gh <argv>` for each call, in order — what the assertions read. */
  lines: () => string[];
}

/** Routes are matched as substrings of the joined argv, in declaration order. */
export function fakeRunner(routes: Record<string, Reply>): FakeRunner {
  const calls: RecordedCall[] = [];
  const run = async (args: string[], stdin?: string): Promise<GhRun> => {
    calls.push({ args, stdin });
    const line = args.join(' ');
    for (const [match, reply] of Object.entries(routes)) {
      if (line.includes(match)) return typeof reply === 'function' ? reply(args, stdin) : reply;
    }
    throw new Error(`unexpected call: ${line}`);
  };
  return { run, calls, lines: () => calls.map((call) => call.args.join(' ')) };
}

/** `gh pr view <n> --json …` */
export const PR_VIEW = JSON.stringify({
  baseRefName: 'main',
  baseRefOid: BASE_SHA,
  headRefName: 'agent/rate-limit',
  headRefOid: HEAD_SHA,
  isCrossRepository: false,
  number: PR_NUMBER,
  state: 'OPEN',
  title: 'Bound the token-bucket retry loop',
  url: 'https://github.com/octo/widget/pull/42',
});

/**
 * gh 2.46 rejects `baseRefOid` client-side, before any request.
 * Recorded verbatim, truncated after the first few available fields.
 */
export const NO_BASE_REF_OID = fail(
  1,
  'Unknown JSON field: "baseRefOid"\nAvailable fields:\n  additions\n  assignees\n  author\n  baseRefName\n  headRefName\n  headRefOid\n',
);

/** `gh api repos/{owner}/{repo}/pulls/<n>` — the fallback for that gh. */
export const PR_REST = JSON.stringify({
  number: PR_NUMBER,
  title: 'Bound the token-bucket retry loop',
  html_url: 'https://github.com/octo/widget/pull/42',
  state: 'open',
  merged: false,
  base: { ref: 'main', sha: BASE_SHA, repo: { full_name: SLUG } },
  head: { ref: 'agent/rate-limit', sha: HEAD_SHA, repo: { full_name: SLUG } },
});

/** The same endpoint for a merged PR from a fork. */
export const PR_REST_FORK = JSON.stringify({
  number: PR_NUMBER,
  title: 'Bound the token-bucket retry loop',
  html_url: 'https://github.com/octo/widget/pull/42',
  state: 'closed',
  merged: true,
  base: { ref: 'main', sha: BASE_SHA, repo: { full_name: SLUG } },
  head: { ref: 'rate-limit', sha: HEAD_SHA, repo: { full_name: 'contributor/widget' } },
});

/** `gh pr view <n> --json headRefOid` — the head guard's own call. */
export const headOid = (sha: string): string => JSON.stringify({ headRefOid: sha });

/** `gh repo view --json nameWithOwner` */
export const REPO_VIEW = JSON.stringify({ nameWithOwner: SLUG });

/** An unauthenticated gh, verbatim. Exit 4 is gh's auth exit code. */
export const AUTH_FAILURE = fail(
  4,
  'gh: To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n',
);

export const NO_SUCH_PR = fail(
  1,
  'GraphQL: Could not resolve to a PullRequest with the number of 999. (repository.pullRequest)\n',
);

export const GH_MISSING = fail(127, 'gh: command not found');

const comment = (fields: Record<string, unknown>): Record<string, unknown> => ({
  path: 'src/limit.ts',
  line: 42,
  side: 'RIGHT',
  user: { login: 'octocat' },
  created_at: '2026-08-19T10:00:00Z',
  html_url: `https://github.com/octo/widget/pull/42#discussion_r${String(fields.id)}`,
  ...fields,
});

/**
 * Two pages exactly as `gh api --paginate` emits them: one JSON array per page,
 * concatenated with no wrapper. Between them the fixture covers every shape the
 * mapping has a rule for — a vsdiff-posted root, a colleague's reply to it, a
 * marker-less comment on the LEFT side, an unplaceable comment, a marked reply,
 * and an outdated comment that still has its original line.
 */
export const COMMENTS_PAGE_1 = JSON.stringify([
  comment({
    id: 5001,
    body: '<!-- vsdiff:t1 -->\nthis retry loop can spin forever',
    user: { login: 'example-reviewer' },
  }),
  comment({
    id: 5002,
    body: 'good catch — bounding it at 5',
    in_reply_to_id: 5001,
    created_at: '2026-08-19T10:05:00Z',
  }),
]);

export const COMMENTS_PAGE_2 = JSON.stringify([
  comment({
    id: 5003,
    path: 'src/api/client.ts',
    line: 10,
    side: 'LEFT',
    body: 'why drop the retry header here?',
    created_at: '2026-08-19T10:06:00Z',
  }),
  comment({
    id: 5004,
    path: 'README.md',
    line: null,
    original_line: null,
    side: null,
    body: 'nit: stale sentence',
    created_at: '2026-08-19T10:07:00Z',
  }),
  comment({
    id: 5005,
    body: '<!-- vsdiff:t1 -->\naddressed in 3c4d5e6',
    in_reply_to_id: 5001,
    user: { login: 'example-reviewer' },
    created_at: '2026-08-19T10:08:00Z',
  }),
  comment({
    id: 5006,
    path: 'src/limit.ts',
    line: null,
    original_line: 7,
    body: 'this moved, but it still reads oddly',
    created_at: '2026-08-19T10:09:00Z',
  }),
]);

export const COMMENTS_PAGED = `${COMMENTS_PAGE_1}\n${COMMENTS_PAGE_2}\n`;

/** `gh api …/reviews --method POST` on success. */
export const REVIEW_CREATED = JSON.stringify({
  id: 77001,
  state: 'COMMENTED',
  commit_id: HEAD_SHA,
  html_url: 'https://github.com/octo/widget/pull/42#pullrequestreview-77001',
});

/** GitHub's 422 as gh relays it: body on stdout, its own summary on stderr. */
export const REVIEW_422 = fail(
  1,
  'gh: Unprocessable Entity (HTTP 422)\n',
  JSON.stringify({
    message: 'Unprocessable Entity',
    errors: [
      'pull_request_review_thread.line must be part of the diff',
      'pull_request_review_thread.path diff too large',
    ],
    documentation_url: 'https://docs.github.com/rest/pulls/reviews#create-a-review',
    status: '422',
  }),
);

/** The variant whose message names a file — one comment can be singled out. */
export const REVIEW_422_NAMED = fail(
  1,
  'gh: Validation Failed (HTTP 422)\n',
  JSON.stringify({
    message: 'Validation Failed',
    errors: [
      {
        resource: 'PullRequestReviewComment',
        code: 'custom',
        field: 'line',
        message: 'src/api/client.ts: line must be part of the diff',
      },
    ],
    status: '422',
  }),
);
