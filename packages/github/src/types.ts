// The public contract for @vsdiff/github (blueprint §7.5 / D5): GitHub is a
// projection of local state, reached only through the `gh` CLI. Every call goes
// through an injectable runner, so nothing here needs a token, an HTTP client
// or the network to be tested — changes to this file need tech-lead review.

import type { CommentEvent, ReplyEvent } from '@vsdiff/core';

export interface GhRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** `gh <args>` in the repo. `stdin` feeds `--input -` (the review POST body). */
export type RunGh = (args: string[], stdin?: string) => Promise<GhRun>;

/** `git <args>` in the repo — only used to read back what `gh pr checkout` did. */
export type RunGit = (args: string[]) => Promise<GhRun>;

/** Both default to running the real binaries in `repoRoot`; tests pass fakes. */
export interface GhDeps {
  runGh?: RunGh;
  runGit?: RunGit;
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  baseRefName: string;
  headRefName: string;
  /** `baseRefOid` — a pinned SHA, never a ref name. */
  baseSha: string;
  /** `headRefOid` — the head-moved guard (D5) compares against exactly this. */
  headSha: string;
  isCrossRepository: boolean;
  /** `OPEN` | `CLOSED` | `MERGED` as gh reports it; unknown values pass through. */
  state: string;
}

export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

/** GitHub's diff side: RIGHT is the head version, LEFT the base version. */
export type ReviewSide = 'RIGHT' | 'LEFT';

/** One local thread projected onto the PR's head diff. */
export interface PublishThread {
  /** vsdiff thread id — becomes the `<!-- vsdiff:<id> -->` idempotency marker. */
  id: string;
  path: string;
  line: number;
  side: ReviewSide;
  body: string;
}

export interface PublishOptions {
  prNumber: number;
  /** The head the session was authored against; publishing refuses if it moved. */
  headSha: string;
  event: ReviewEvent;
  body: string;
  threads: PublishThread[];
}

export interface PostedComment {
  /** The local thread id, not a remote id — the review POST returns neither. */
  id: string;
  path: string;
  line: number;
}

export interface PublishResult {
  posted: PostedComment[];
  /** Thread ids whose marker was already on the PR — published earlier. */
  skipped: string[];
  reviewUrl?: string;
  reviewId?: number;
}

/** A PR review comment as GitHub has it, normalised. */
export interface RemoteComment {
  remoteId: number;
  /** The vsdiff thread id from the body's marker, when it carries one. */
  threadMarker: string | null;
  path: string;
  /** null when GitHub has no line for it (outdated with no original line). */
  line: number | null;
  side: ReviewSide | null;
  /** The body with the marker line removed. */
  body: string;
  author: string;
  createdAt: string;
  /** The comment this one answers, for replies. */
  inReplyTo: number | null;
  url: string;
}

/** Where an imported event came from, for receipts and reconciliation. */
export interface RemoteRef {
  id: number;
  url: string;
}

export interface GithubCommentEvent extends CommentEvent {
  origin: 'github';
  remote: RemoteRef;
}

export interface GithubReplyEvent extends ReplyEvent {
  origin: 'github';
  remote: RemoteRef;
}

export type GithubFeedbackEvent = GithubCommentEvent | GithubReplyEvent;
