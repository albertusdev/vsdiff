// Inbound is import, not sync (D5): on demand, read the PR's review comments
// and normalise them. Nothing here decides what to do with them — that is
// `toFeedbackEvents`, which is pure and testable on this output alone.

import { ghError } from './errors.ts';
import { isRecord, num, parseJsonPages, str } from './json.ts';
import { isReviewMarker, parseMarker } from './markers.ts';
import { nameWithOwner } from './repo.ts';
import { makeRunGh, requirePrNumber } from './run.ts';
import type { GhDeps, RemoteComment, ReviewSide, RunGh } from './types.ts';

/** The raw review comments of a PR, every page of them. */
export async function fetchReviewComments(
  runGh: RunGh,
  slug: string,
  prNumber: number,
): Promise<unknown[]> {
  const args = ['api', `repos/${slug}/pulls/${prNumber}/comments`, '--paginate'];
  const run = await runGh(args);
  if (run.code !== 0) throw ghError(args, run, `pull request #${prNumber}`);
  return parseJsonPages(args, 'review comments JSON', run.stdout);
}

function sideOf(value: unknown): ReviewSide | null {
  return value === 'LEFT' || value === 'RIGHT' ? value : null;
}

/** null for anything that isn't a review comment we can anchor a thread to. */
export function normalizeComment(raw: unknown): RemoteComment | null {
  if (!isRecord(raw)) return null;
  const remoteId = num(raw.id);
  if (remoteId === null) return null;

  const { marker, body } = parseMarker(str(raw.body));
  const user = isRecord(raw.user) ? str(raw.user.login, 'unknown') : 'unknown';
  return {
    remoteId,
    // A review-body marker names a review, not a thread — never a thread id.
    threadMarker: marker === null || isReviewMarker(marker) ? null : marker,
    path: str(raw.path),
    // `line` goes null once a comment is outdated; `original_line` still says
    // where the reviewer was looking, which is the useful answer.
    line: num(raw.line) ?? num(raw.original_line),
    side: sideOf(raw.side),
    body,
    author: user,
    createdAt: str(raw.created_at),
    inReplyTo: num(raw.in_reply_to_id),
    url: str(raw.html_url),
  };
}

export async function pullComments(
  repoRoot: string,
  prNumber: number,
  deps: GhDeps = {},
): Promise<RemoteComment[]> {
  const number = requirePrNumber(prNumber);
  const runGh = deps.runGh ?? makeRunGh(repoRoot);
  const slug = await nameWithOwner(runGh);
  const raw = await fetchReviewComments(runGh, slug, number);

  const comments: RemoteComment[] = [];
  for (const entry of raw) {
    const comment = normalizeComment(entry);
    if (comment !== null) comments.push(comment);
  }
  return comments;
}
