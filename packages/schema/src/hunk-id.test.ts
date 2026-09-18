import { expect, test } from 'vitest';
import { formatHunkId, isHunkId, parseHunkId, validateSession } from './index.ts';

test('parses an ordinary hunk id', () => {
  expect(parseHunkId('src/auth/middleware.ts:h2')).toEqual({
    path: 'src/auth/middleware.ts',
    n: 2,
  });
});

test('parses a multi-digit ordinal', () => {
  expect(parseHunkId('src/a.ts:h12')).toEqual({ path: 'src/a.ts', n: 12 });
});

test('splits at the LAST :h<n> suffix, so a path may contain one', () => {
  expect(parseHunkId('a:h2b.ts:h1')).toEqual({ path: 'a:h2b.ts', n: 1 });
});

test('treats a trailing :h<n> as the separator even when the path ends in one', () => {
  expect(parseHunkId('src/a.ts:h1:h2')).toEqual({ path: 'src/a.ts:h1', n: 2 });
});

test('accepts a path made only of colons and text', () => {
  expect(parseHunkId('weird::h3')).toEqual({ path: 'weird:', n: 3 });
});

test.each([
  ['src/a.ts', 'no :h<n> suffix'],
  ['src/a.ts:h0', 'ordinals are 1-based'],
  ['src/a.ts:h01', 'no leading zeros'],
  ['src/a.ts:h1x', 'trailing junk'],
  ['src/a.ts:H1', 'the h is lowercase'],
  ['src/a.ts:h', 'no ordinal'],
  [':h1', 'empty path'],
  ['src/a.ts:h1 ', 'trailing space'],
  ['src/a.ts:h-1', 'no negative ordinals'],
])('rejects %j (%s)', (id) => {
  expect(isHunkId(id)).toBe(false);
  expect(parseHunkId(id)).toBeNull();
});

test('rejects non-string values', () => {
  expect(isHunkId(1)).toBe(false);
  expect(isHunkId(null)).toBe(false);
  expect(isHunkId(['src/a.ts:h1'])).toBe(false);
});

test('formatHunkId round-trips through parseHunkId', () => {
  const id = formatHunkId('a:h2b.ts', 1);
  expect(id).toBe('a:h2b.ts:h1');
  expect(parseHunkId(id)).toEqual({ path: 'a:h2b.ts', n: 1 });
});

test('the validator accepts a path that contains a :h<n> sequence', () => {
  const doc = {
    version: 1,
    kind: 'review',
    title: 'Odd paths',
    source: { type: 'working-tree' },
    chapters: [
      {
        id: 'c1',
        title: 'Core',
        stops: [{ id: 's1', prose: 'Weird but legal path.', hunkIds: ['a:h2b.ts:h1'] }],
      },
    ],
  };
  expect(validateSession(doc).ok).toBe(true);
});
