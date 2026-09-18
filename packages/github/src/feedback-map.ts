// Remote comments → feedback events, so a colleague on GitHub is just one more
// party in the same conversation (D5: import, not sync). Pure: no gh, no clock,
// no ids invented per run — a second pull over the same comments produces the
// same events, and `knownRemoteIds` is what keeps it from producing them twice.

import type { GithubFeedbackEvent, RemoteComment } from './types.ts';

/** Stable across pulls: the remote id is the only identity GitHub gives us. */
function localId(remoteId: number): string {
  return `gh-${remoteId}`;
}

/**
 * A reply to a thread vsdiff doesn't know: GitHub gives the reply no marker, so
 * it can't be attached — it becomes a comment of its own, with the parent named
 * in the body. The reviewer said something; it never gets dropped for want of a
 * thread to hang it on.
 */
function replyContext(inReplyTo: number): string {
  return `[github reply to comment #${inReplyTo}]`;
}

export function toFeedbackEvents(
  comments: RemoteComment[],
  knownRemoteIds: Set<number>,
): GithubFeedbackEvent[] {
  const events: GithubFeedbackEvent[] = [];
  // A reply carries no marker of its own — the THREAD identity lives on the
  // root comment vsdiff posted. Resolve in_reply_to through the full pull so
  // colleague replies attach to the local thread instead of straying.
  const markerByRemoteId = new Map<number, string>();
  for (const comment of comments) {
    if (comment.threadMarker !== null) markerByRemoteId.set(comment.remoteId, comment.threadMarker);
  }
  for (const comment of comments) {
    if (knownRemoteIds.has(comment.remoteId)) continue;
    const remote = { id: comment.remoteId, url: comment.url };

    const parentMarker =
      comment.threadMarker ??
      (comment.inReplyTo !== null ? (markerByRemoteId.get(comment.inReplyTo) ?? null) : null);

    if (parentMarker !== null) {
      // Marked and top-level: this is vsdiff's own posted comment coming home.
      // The thread already exists locally, so importing it would duplicate the
      // root. `pullComments` still exposes it for receipt reconciliation.
      if (comment.threadMarker !== null && comment.inReplyTo === null) continue;
      events.push({
        type: 'reply',
        ts: comment.createdAt,
        thread: parentMarker,
        body: comment.body,
        author: 'human',
        origin: 'github',
        remote,
      });
      continue;
    }

    events.push({
      type: 'comment',
      ts: comment.createdAt,
      id: localId(comment.remoteId),
      path: comment.path,
      // A comment GitHub can't place any more still has to land somewhere the
      // agent can read it; line 1 of the file it was written against.
      line: comment.line ?? 1,
      side: comment.side === 'LEFT' ? 'base' : 'head',
      body:
        comment.inReplyTo === null
          ? comment.body
          : `${replyContext(comment.inReplyTo)}\n\n${comment.body}`,
      author: 'human',
      origin: 'github',
      remote,
    });
  }
  return events;
}
