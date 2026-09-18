// @vsdiff/github — PR sourcing, the outbox publisher and comment import.
// Hard rules: every GitHub call goes through the `gh` CLI (no Octokit, no
// tokens, no HTTP client), and every function takes injectable runners so the
// whole package is testable without GitHub (blueprint §7.5, D5).

export type {
  GhDeps,
  GhRun,
  GithubCommentEvent,
  GithubFeedbackEvent,
  GithubReplyEvent,
  PostedComment,
  PublishOptions,
  PublishResult,
  PublishThread,
  PullRequest,
  RemoteComment,
  RemoteRef,
  ReviewEvent,
  ReviewSide,
  RunGh,
  RunGit,
} from './types.ts';

export type { GhErrorKind, RejectedComment } from './errors.ts';
export { CommentRejectedError, GhError, HeadMovedError } from './errors.ts';

export { makeRunGh, makeRunGit } from './run.ts';

export type { MarkedBody } from './markers.ts';
export { isReviewMarker, markBody, parseMarker, reviewMarker, threadMarker } from './markers.ts';

export { checkoutPr, prSessionSource, resolvePr } from './pr.ts';
export { publishReview } from './publish.ts';
export { pullComments } from './comments.ts';
export { toFeedbackEvents } from './feedback-map.ts';
