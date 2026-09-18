// Errors the GitHub layer raises. Every one of them has to be actionable at the
// terminal: `gh` failures are classified so the CLI can degrade cleanly to local
// mode with a fix the user can type (blueprint §9 risk table).

import type { GhRun, PostedComment } from './types.ts';

export type GhErrorKind =
  /** `gh` isn't installed or isn't on PATH. */
  | 'gh-missing'
  /** `gh` is there but not authenticated for this host. */
  | 'auth'
  /** Not a GitHub checkout: no remote gh can resolve. */
  | 'no-repo'
  /** The PR (or endpoint) doesn't exist. */
  | 'not-found'
  /** `gh` succeeded but printed something we can't read. */
  | 'output'
  /** Anything else `gh` failed with. */
  | 'failed';

export interface GhErrorInit {
  kind: GhErrorKind;
  args: string[];
  code: number;
  stderr: string;
  hint?: string;
}

export class GhError extends Error {
  readonly kind: GhErrorKind;
  readonly args: string[];
  readonly code: number;
  readonly stderr: string;
  /** A command the user can run to fix it; empty when there isn't one. */
  readonly hint: string;

  constructor(message: string, init: GhErrorInit) {
    super(init.hint === undefined || init.hint === '' ? message : `${message}\n${init.hint}`);
    this.name = 'GhError';
    this.kind = init.kind;
    this.args = init.args;
    this.code = init.code;
    this.stderr = init.stderr;
    this.hint = init.hint ?? '';
  }
}

const AUTH =
  /gh auth login|GH_TOKEN|GITHUB_TOKEN|authentication token|Bad credentials|not logged in|requires authentication|HTTP 401|HTTP 403/i;
const NO_REPO =
  /not a git repository|no git remotes found|none of the git remotes|could not determine (?:the )?base repository|no remotes found/i;
const NOT_FOUND =
  /could not resolve to a (?:pullrequest|repository)|no pull requests found|GraphQL: Could not resolve|HTTP 404|not found/i;
const MISSING = /command not found|ENOENT|executable file not found|no such file or directory/i;

export function classifyGh(run: GhRun): GhErrorKind {
  const text = `${run.stderr}\n${run.stdout}`;
  if (run.code === 127 || MISSING.test(text)) return 'gh-missing';
  if (AUTH.test(text)) return 'auth';
  if (NO_REPO.test(text)) return 'no-repo';
  if (NOT_FOUND.test(text)) return 'not-found';
  return 'failed';
}

function hintFor(kind: GhErrorKind, subject: string): string {
  switch (kind) {
    case 'gh-missing':
      return 'the GitHub CLI is not on PATH — install it (https://cli.github.com); vsdiff talks to GitHub only through `gh`.';
    case 'auth':
      return 'gh is not authenticated for this host — run `gh auth login` (check with `gh auth status`).';
    case 'no-repo':
      return 'this checkout has no GitHub remote gh can resolve — run it where `gh repo view` works, or pass the repo explicitly.';
    case 'not-found':
      return subject === ''
        ? 'gh could not find it — check the number and that you can see the repository.'
        : `gh cannot see ${subject} — check the number and your access (\`gh pr list\`).`;
    default:
      return '';
  }
}

/** The first non-empty line of gh's complaint — the rest is usually noise. */
export function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return '';
}

/** Turns a failed run into an actionable error. `subject` names what was asked for. */
export function ghError(args: string[], run: GhRun, subject = ''): GhError {
  const kind = classifyGh(run);
  const detail = firstLine(run.stderr) || firstLine(run.stdout) || 'no output';
  // gh api prints the response body (with GitHub's real errors[]) to stdout —
  // "Unprocessable Entity" alone told a live user nothing (sandbox finding:
  // the actual reason was "Can not request changes on your own pull request").
  const apiErrors = extractApiErrors(run.stdout);
  const message = `gh ${args.join(' ')} failed (exit ${run.code}): ${detail}${
    apiErrors === '' ? '' : ` — ${apiErrors}`
  }`;
  const hint = hintFor(kind, subject);
  return new GhError(message, {
    kind,
    args,
    code: run.code,
    stderr: run.stderr,
    ...(hint === '' ? {} : { hint }),
  });
}

/** GitHub's errors[]/message from a JSON error body on stdout, or ''. */
function extractApiErrors(stdout: string): string {
  try {
    const body = JSON.parse(stdout) as { errors?: unknown[]; message?: string };
    const parts: string[] = [];
    for (const entry of body.errors ?? []) {
      if (typeof entry === 'string') parts.push(entry);
      else if (entry && typeof entry === 'object' && 'message' in entry) {
        parts.push(String((entry as { message: unknown }).message));
      }
    }
    if (parts.length === 0 && typeof body.message === 'string') parts.push(body.message);
    return parts.join('; ').slice(0, 300);
  } catch {
    return '';
  }
}

/** gh printed something where JSON was expected — a gh version skew, usually. */
export function outputError(args: string[], context: string, raw: string): GhError {
  const snippet = raw.trim().slice(0, 200);
  return new GhError(
    `gh ${args.join(' ')} returned unreadable ${context}: ${snippet === '' ? '(empty)' : snippet}`,
    {
      kind: 'output',
      args,
      code: 0,
      stderr: '',
      hint: 'check `gh --version` — vsdiff needs a gh that emits the documented JSON fields.',
    },
  );
}

/**
 * The PR moved under the session (D5): the session pinned `expected`, GitHub is
 * now at `actual`. Publishing stops here — comments must never land on lines
 * that shifted; the caller re-anchors against the fresh diff and tries again.
 */
export class HeadMovedError extends Error {
  readonly prNumber: number;
  readonly expected: string;
  readonly actual: string;

  constructor(prNumber: number, expected: string, actual: string) {
    super(
      `PR #${prNumber} has moved: this review was authored against ${expected}, the PR head is now ${actual} — re-anchor against the fresh diff before publishing.`,
    );
    this.name = 'HeadMovedError';
    this.prNumber = prNumber;
    this.expected = expected;
    this.actual = actual;
  }
}

export interface RejectedComment extends PostedComment {
  /** GitHub's message, when one of them named this comment's file. */
  reason?: string;
}

/**
 * GitHub refused the review (422 — a path or line that isn't in its diff). A
 * review posts atomically, so NOTHING landed: the caller re-anchors and
 * publishes again. Never retried here — a blind retry is how you double-post.
 */
export class CommentRejectedError extends GhError {
  readonly status: number;
  /** The comments GitHub named, or all of them when it named none. */
  readonly rejected: RejectedComment[];
  /** Everything in the rejected review — none of it was posted. */
  readonly attempted: PostedComment[];
  readonly messages: string[];

  constructor(init: {
    args: string[];
    run: GhRun;
    status: number;
    rejected: RejectedComment[];
    attempted: PostedComment[];
    messages: string[];
  }) {
    const listed = init.rejected
      .map(
        (c) => `  ${c.path}:${c.line} (${c.id})${c.reason === undefined ? '' : ` — ${c.reason}`}`,
      )
      .join('\n');
    const why = init.messages.length === 0 ? '' : `\n${init.messages.join('\n')}`;
    super(
      `GitHub rejected the review (HTTP ${init.status}) — nothing was posted. ${init.rejected.length} comment(s) could not be placed:\n${listed}${why}`,
      {
        kind: 'failed',
        args: init.args,
        code: init.run.code,
        stderr: init.run.stderr,
        hint: 're-anchor those comments against the current PR diff and publish again — do not retry as-is.',
      },
    );
    this.name = 'CommentRejectedError';
    this.status = init.status;
    this.rejected = init.rejected;
    this.attempted = init.attempted;
    this.messages = init.messages;
  }
}
