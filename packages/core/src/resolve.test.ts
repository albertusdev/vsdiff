import { expect, test } from 'vitest';
import type { ReviewSession } from '@vsdiff/schema';
import type { DiffFile, DiffResult } from './types.ts';
import { resolveSession } from './resolve.ts';

function file(path: string, hunkCount: number): DiffFile {
  return {
    path,
    status: 'modified',
    binary: false,
    additions: hunkCount,
    deletions: 0,
    hunks: Array.from({ length: hunkCount }, (_, i) => ({
      id: `${path}:h${i + 1}`,
      n: i + 1,
      header: `@@ -${i + 1},1 +${i + 1},2 @@`,
      oldStart: i + 1,
      oldLines: 1,
      newStart: i + 1,
      newLines: 2,
      additions: 1,
      deletions: 0,
      text: '',
    })),
  };
}

const diff: DiffResult = {
  source: { type: 'range', base: 'main', head: 'HEAD' },
  repoRoot: '/tmp/x',
  headSha: 'abc',
  files: [file('src/a.ts', 2), file('src/b.ts', 1), file('vendor/lock.txt', 1)],
};

const session = {
  version: 1,
  kind: 'review',
  title: 'T',
  source: { type: 'range', base: 'main', head: 'HEAD' },
  chapters: [
    {
      id: 'c1',
      title: 'C1',
      stops: [
        { id: 's1', prose: 'p', hunkIds: ['src/a.ts:h1'] },
        { id: 's2', prose: 'p', hunkIds: ['src/a.ts:h2', 'src/gone.ts:h1'] },
      ],
    },
  ],
  support: [{ id: 'lock', reason: 'generated', hunkIds: ['vendor/lock.txt:h1'] }],
} as unknown as ReviewSession;

test('resolves hunks, marks stale stops, buckets uncovered', () => {
  const resolved = resolveSession(session, diff);

  expect(resolved.stops).toHaveLength(2);
  expect(resolved.stops[0]?.stale).toBe(false);
  expect(resolved.stops[0]?.hunks[0]?.hunk.id).toBe('src/a.ts:h1');

  expect(resolved.stops[1]?.stale).toBe(true);
  expect(resolved.stops[1]?.missingHunkIds).toEqual(['src/gone.ts:h1']);
  expect(resolved.stops[1]?.hunks).toHaveLength(1);

  expect(resolved.support[0]?.hunks).toHaveLength(1);

  // src/b.ts:h1 is referenced by nothing → uncovered.
  expect(resolved.uncovered).toHaveLength(1);
  expect(resolved.uncovered[0]?.file.path).toBe('src/b.ts');

  expect(resolved.stats).toEqual({
    totalHunks: 4,
    coveredHunks: 3,
    staleStops: 1,
    missingRefs: 1,
  });
});

test('priority defaults to must, inherits the chapter, and yields to the stop', () => {
  const tiered = {
    ...session,
    chapters: [
      { id: 'c1', title: 'C1', stops: [{ id: 's1', prose: 'p', hunkIds: ['src/a.ts:h1'] }] },
      {
        id: 'c2',
        title: 'C2',
        priority: 'nice',
        stops: [
          { id: 's2', prose: 'p', hunkIds: ['src/a.ts:h2'] },
          { id: 's3', prose: 'p', priority: 'must', hunkIds: ['src/b.ts:h1'] },
        ],
      },
    ],
  } as unknown as ReviewSession;
  const resolved = resolveSession(tiered, diff);
  expect(resolved.stops.map((s) => [s.stop.id, s.priority])).toEqual([
    ['s1', 'must'],
    ['s2', 'nice'],
    ['s3', 'must'],
  ]);
});

test('global stop indices span chapters in order', () => {
  const two = {
    ...session,
    chapters: [
      { id: 'c1', title: 'C1', stops: [{ id: 's1', prose: 'p', hunkIds: ['src/a.ts:h1'] }] },
      { id: 'c2', title: 'C2', stops: [{ id: 's2', prose: 'p', hunkIds: ['src/b.ts:h1'] }] },
    ],
  } as unknown as ReviewSession;
  const resolved = resolveSession(two, diff);
  expect(resolved.stops.map((s) => [s.index, s.chapterId])).toEqual([
    [0, 'c1'],
    [1, 'c2'],
  ]);
});
