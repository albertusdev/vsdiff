// Idempotency markers (D5). Every body vsdiff posts carries an invisible HTML
// comment naming what it is, so a re-publish can see its own work already on the
// PR and skip it, and a pull can match a remote comment back to a local thread.
// The marker is a whole line of its own: stripping it back out has to be exact.

const MARKER =
  /^[^\S\r\n]*<!--[^\S\r\n]*vsdiff:([A-Za-z0-9_.:@/-]+)[^\S\r\n]*-->[^\S\r\n]*(?:\r?\n)?/m;

/** Marks a comment as the projection of local thread `id`. */
export function threadMarker(id: string): string {
  return `<!-- vsdiff:${id} -->`;
}

/** Marks the review body, pinned to the head it was written against. */
export function reviewMarker(headSha: string): string {
  return `<!-- vsdiff:review:${headSha} -->`;
}

/** Marker first, then the body — one line, always, so the strip is unambiguous. */
export function markBody(marker: string, body: string): string {
  return `${marker}\n${body}`;
}

export interface MarkedBody {
  /** What the marker named (`t1`, or `review:<sha>`), or null when unmarked. */
  marker: string | null;
  /** The body with the marker's line removed; unchanged when there is none. */
  body: string;
}

export function parseMarker(raw: string): MarkedBody {
  const match = MARKER.exec(raw);
  if (match === null || match[1] === undefined) return { marker: null, body: raw };
  return {
    marker: match[1],
    body: raw.slice(0, match.index) + raw.slice(match.index + match[0].length),
  };
}

/** True for the review-body marker, which names a review and not a thread. */
export function isReviewMarker(marker: string): boolean {
  return marker.startsWith('review:');
}
