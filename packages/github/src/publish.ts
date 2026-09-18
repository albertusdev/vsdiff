// The outbox projection (blueprint D5): local threads become ONE GitHub review,
// submitted atomically. Three properties are non-negotiable here, and the order
// of the steps below is what enforces them:
//
//   1. Never post onto shifted lines — the head guard runs before anything else.
//   2. Never double-post — every body carries a `<!-- vsdiff:<id> -->` marker
//      and the PR's existing comments are read back to filter what's already up.
//   3. Never retry blindly — a rejected review posted nothing, so the caller
//      re-anchors and publishes again rather than this code trying twice.

import { CommentRejectedError, firstLine, ghError, HeadMovedError, outputError } from './errors.ts';
import { isRecord, num, parseJsonObject, str } from './json.ts';
import { markBody, parseMarker, reviewMarker, threadMarker } from './markers.ts';
import { fetchReviewComments } from './comments.ts';
import { nameWithOwner } from './repo.ts';
import { makeRunGh, requirePrNumber } from './run.ts';
import type {
  GhDeps,
  GhRun,
  PostedComment,
  PublishOptions,
  PublishResult,
  PublishThread,
  RunGh,
} from './types.ts';
import type { RejectedComment } from './errors.ts';

/** The PR's head right now — the one number the guard is allowed to trust. */
async function prHeadSha(runGh: RunGh, prNumber: number): Promise<string> {
  const args = ['pr', 'view', String(prNumber), '--json', 'headRefOid'];
  const run = await runGh(args);
  if (run.code !== 0) throw ghError(args, run, `pull request #${prNumber}`);
  const raw = parseJsonObject(args, 'pull request JSON', run.stdout);
  const sha = str(raw.headRefOid);
  if (sha === '') throw outputError(args, 'headRefOid (a commit sha)', run.stdout);
  return sha;
}

/** Sessions pin a full SHA (that is what `resolvePr` hands out); case only. */
function sameSha(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Thread ids already on the PR, read off the markers in its comment bodies. */
function postedMarkers(rawComments: unknown[]): Set<string> {
  const markers = new Set<string>();
  for (const raw of rawComments) {
    if (!isRecord(raw)) continue;
    const { marker } = parseMarker(str(raw.body));
    if (marker !== null) markers.add(marker);
  }
  return markers;
}

function toPosted(thread: PublishThread): PostedComment {
  return { id: thread.id, path: thread.path, line: thread.line };
}

const HTTP_STATUS = /\(HTTP (\d{3})\)/;

function httpStatus(run: GhRun): number {
  const match = HTTP_STATUS.exec(run.stderr) ?? HTTP_STATUS.exec(run.stdout);
  if (match?.[1] !== undefined) return Number(match[1]);
  const body = errorBody(run);
  if (body === null) return 0;
  // GitHub's JSON error body carries `status` as a string ("422").
  const status = num(body.status) ?? Number.parseInt(str(body.status), 10);
  return Number.isFinite(status) ? status : 0;
}

/** gh prints the API's error body on stdout and its own summary on stderr. */
function errorBody(run: GhRun): Record<string, unknown> | null {
  for (const raw of [run.stdout, run.stderr]) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Not the JSON body — try the other stream.
    }
  }
  return null;
}

/**
 * Everything GitHub said about the rejection. `errors` comes back both as bare
 * strings ("pull_request_review_thread.line must be part of the diff") and as
 * objects, so both shapes are flattened into one list the user can read.
 */
function errorMessages(run: GhRun): string[] {
  const body = errorBody(run);
  const messages: string[] = [];
  if (body !== null) {
    const message = str(body.message);
    if (message !== '') messages.push(message);
    const errors = body.errors;
    if (Array.isArray(errors)) {
      for (const entry of errors) {
        if (typeof entry === 'string') messages.push(entry);
        else if (isRecord(entry)) {
          const detail = str(entry.message);
          messages.push(
            detail !== ''
              ? detail
              : `${str(entry.field, 'comment')}: ${str(entry.code, 'invalid')}`,
          );
        }
      }
    }
  }
  if (messages.length === 0) {
    const detail = firstLine(run.stderr) || firstLine(run.stdout);
    if (detail !== '') messages.push(detail);
  }
  return messages;
}

/**
 * Publishes the selected threads as one review on the PR.
 *
 * Throws `HeadMovedError` when the PR moved past `options.headSha` (re-anchor,
 * then publish again) and `CommentRejectedError` when GitHub refuses a comment's
 * path/line — a review is atomic, so in both cases nothing was posted.
 */
export async function publishReview(
  repoRoot: string,
  options: PublishOptions,
  deps: GhDeps = {},
): Promise<PublishResult> {
  const prNumber = requirePrNumber(options.prNumber);
  const runGh = deps.runGh ?? makeRunGh(repoRoot);

  const head = await prHeadSha(runGh, prNumber);
  if (!sameSha(head, options.headSha)) {
    throw new HeadMovedError(prNumber, options.headSha, head);
  }

  const slug = await nameWithOwner(runGh);
  const alreadyPosted = postedMarkers(await fetchReviewComments(runGh, slug, prNumber));

  const outbox: PublishThread[] = [];
  const skipped: string[] = [];
  const batch = new Set<string>();
  for (const thread of options.threads) {
    // A marker already on the PR, or a duplicate inside this batch: either way
    // posting it again would be the double-post the markers exist to prevent.
    if (alreadyPosted.has(thread.id) || batch.has(thread.id)) {
      skipped.push(thread.id);
      continue;
    }
    batch.add(thread.id);
    outbox.push(thread);
  }

  // Everything was already up and there is no body to add: a review with no
  // content is a 422, and saying nothing is the honest result anyway.
  if (outbox.length === 0 && options.body.trim() === '' && options.event === 'COMMENT') {
    return { posted: [], skipped };
  }

  const payload = {
    commit_id: options.headSha,
    event: options.event,
    body: markBody(reviewMarker(options.headSha), options.body),
    comments: outbox.map((thread) => ({
      path: thread.path,
      line: thread.line,
      side: thread.side,
      body: markBody(threadMarker(thread.id), thread.body),
    })),
  };

  const args = [
    'api',
    `repos/${slug}/pulls/${prNumber}/reviews`,
    '--method',
    'POST',
    '--input',
    '-',
  ];
  const run = await runGh(args, JSON.stringify(payload));
  if (run.code !== 0) {
    const status = httpStatus(run);
    const attempted = outbox.map(toPosted);
    if (status === 422 && attempted.length > 0) {
      const messages = errorMessages(run);
      // GitHub usually rejects without naming a comment, and then every one of
      // them is suspect. When it does name files, `rejected` narrows to those —
      // `attempted` always carries the whole review, none of which was posted.
      const named: RejectedComment[] = [];
      for (const comment of attempted) {
        const reason = messages.find((message) => message.includes(comment.path));
        if (reason !== undefined) named.push({ ...comment, reason });
      }
      throw new CommentRejectedError({
        args,
        run,
        status,
        rejected: named.length > 0 ? named : attempted,
        attempted,
        messages,
      });
    }
    throw ghError(args, run, `pull request #${prNumber}`);
  }

  const review = parseJsonObject(args, 'review JSON', run.stdout);
  const reviewUrl = str(review.html_url);
  const reviewId = num(review.id);
  return {
    posted: outbox.map(toPosted),
    skipped,
    ...(reviewUrl === '' ? {} : { reviewUrl }),
    ...(reviewId === null ? {} : { reviewId }),
  };
}
