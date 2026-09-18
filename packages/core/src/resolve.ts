// Session ↔ diff resolution (blueprint §6 "Anchoring & repair", P1 scope):
// exact hunk-id resolution, stale marking, and the uncovered bucket. Fuzzy
// re-pinning by content similarity is deliberately deferred (P1.5) — visible
// staleness beats a confident wrong pin.

import type { Chapter, Priority, ReviewSession, Stop } from '@vsdiff/schema';
import type { DiffFile, DiffHunk, DiffResult } from './types.ts';

export interface ResolvedHunkRef {
  file: DiffFile;
  hunk: DiffHunk;
}

export interface ResolvedStop {
  stop: Stop;
  chapterId: string;
  /** Global 0-based position on the review path. */
  index: number;
  hunks: ResolvedHunkRef[];
  missingHunkIds: string[];
  /** True when at least one referenced hunk failed to resolve. */
  stale: boolean;
  /** Effective tier: the stop's own, else its chapter's, else `'must'`. */
  priority: Priority;
}

export interface ResolvedChapter {
  chapter: Chapter;
  stops: ResolvedStop[];
}

export interface ResolvedSupportGroup {
  id: string;
  reason: string;
  note?: string;
  hunks: ResolvedHunkRef[];
  missingHunkIds: string[];
}

export interface UncoveredFile {
  file: DiffFile;
  hunks: DiffHunk[];
}

export interface ResolvedSession {
  session: ReviewSession;
  diff: DiffResult;
  chapters: ResolvedChapter[];
  stops: ResolvedStop[];
  support: ResolvedSupportGroup[];
  /** Changed hunks no stop or support group references — always shown. */
  uncovered: UncoveredFile[];
  stats: {
    totalHunks: number;
    coveredHunks: number;
    staleStops: number;
    missingRefs: number;
  };
}

interface SupportLike {
  id?: unknown;
  reason?: unknown;
  note?: unknown;
  hunkIds?: unknown;
}

/** The loader is permissive, so anything the strict validator would reject reads as unset. */
const priorityOf = (value: unknown): Priority | undefined =>
  value === 'must' || value === 'nice' ? value : undefined;

export function resolveSession(session: ReviewSession, diff: DiffResult): ResolvedSession {
  const hunkById = new Map<string, ResolvedHunkRef>();
  for (const file of diff.files) {
    for (const hunk of file.hunks) {
      hunkById.set(hunk.id, { file, hunk });
    }
  }

  const covered = new Set<string>();
  const take = (ids: readonly string[] | undefined) => {
    const hunks: ResolvedHunkRef[] = [];
    const missing: string[] = [];
    for (const id of ids ?? []) {
      const ref = hunkById.get(id);
      if (ref) {
        hunks.push(ref);
        covered.add(id);
      } else {
        missing.push(id);
      }
    }
    return { hunks, missing };
  };

  const chapters: ResolvedChapter[] = [];
  const stops: ResolvedStop[] = [];
  for (const chapter of session.chapters) {
    const resolvedStops: ResolvedStop[] = [];
    for (const stop of chapter.stops) {
      const { hunks, missing } = take(stop.hunkIds);
      const resolved: ResolvedStop = {
        stop,
        chapterId: chapter.id,
        index: stops.length,
        hunks,
        missingHunkIds: missing,
        stale: missing.length > 0,
        priority: priorityOf(stop.priority) ?? priorityOf(chapter.priority) ?? 'must',
      };
      resolvedStops.push(resolved);
      stops.push(resolved);
    }
    chapters.push({ chapter, stops: resolvedStops });
  }

  const support: ResolvedSupportGroup[] = [];
  const supportInput = Array.isArray(session['support'])
    ? (session['support'] as SupportLike[])
    : [];
  for (const group of supportInput) {
    const ids = Array.isArray(group.hunkIds) ? (group.hunkIds as string[]) : [];
    const { hunks, missing } = take(ids);
    support.push({
      id: typeof group.id === 'string' ? group.id : `support-${support.length + 1}`,
      reason: typeof group.reason === 'string' ? group.reason : 'support',
      ...(typeof group.note === 'string' ? { note: group.note } : {}),
      hunks,
      missingHunkIds: missing,
    });
  }

  const uncovered: UncoveredFile[] = [];
  let totalHunks = 0;
  for (const file of diff.files) {
    totalHunks += file.hunks.length;
    const left = file.hunks.filter((hunk) => !covered.has(hunk.id));
    if (left.length > 0) {
      uncovered.push({ file, hunks: left });
    }
  }

  const missingRefs =
    stops.reduce((sum, s) => sum + s.missingHunkIds.length, 0) +
    support.reduce((sum, g) => sum + g.missingHunkIds.length, 0);

  return {
    session,
    diff,
    chapters,
    stops,
    support,
    uncovered,
    stats: {
      totalHunks,
      coveredHunks: covered.size,
      staleStops: stops.filter((s) => s.stale).length,
      missingRefs,
    },
  };
}
