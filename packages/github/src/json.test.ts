import { expect, test } from 'vitest';
import { GhError } from './errors.ts';
import { parseJsonObject, parseJsonPages } from './json.ts';

const ARGS = ['api', 'repos/octo/widget/pulls/42/comments', '--paginate'];

test('one page parses', () => {
  expect(parseJsonPages(ARGS, 'comments', '[{"id":1},{"id":2}]')).toEqual([{ id: 1 }, { id: 2 }]);
});

test('concatenated pages merge in order', () => {
  const raw = '[{"id":1}]\n[{"id":2},{"id":3}]\n[]\n';

  expect(parseJsonPages(ARGS, 'comments', raw)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
});

test('brackets inside strings do not split a page', () => {
  const raw = '[{"body":"see [1] and ] and \\" ["}][{"id":2}]';

  expect(parseJsonPages(ARGS, 'comments', raw)).toEqual([
    { body: 'see [1] and ] and " [' },
    { id: 2 },
  ]);
});

test('a stream of bare objects parses too', () => {
  expect(parseJsonPages(ARGS, 'comments', '{"id":1}\n{"id":2}\n')).toEqual([{ id: 1 }, { id: 2 }]);
});

test('empty output is no items, not an error', () => {
  expect(parseJsonPages(ARGS, 'comments', '   \n')).toEqual([]);
});

test('output that is not JSON is reported as gh output, not swallowed', () => {
  const error = (() => {
    try {
      parseJsonPages(ARGS, 'comments', 'gh: something went sideways');
      return null;
    } catch (thrown) {
      return thrown;
    }
  })();

  expect(error).toBeInstanceOf(GhError);
  expect((error as GhError).kind).toBe('output');
});

test('a truncated page is an error, never a half-read list', () => {
  expect(() => parseJsonPages(ARGS, 'comments', '[{"id":1},{"id":2}')).toThrow(GhError);
});

test('parseJsonObject rejects anything that is not one object', () => {
  expect(parseJsonObject(ARGS, 'pr', '{"number":42}')).toEqual({ number: 42 });
  expect(() => parseJsonObject(ARGS, 'pr', '[]')).toThrow(GhError);
  expect(() => parseJsonObject(ARGS, 'pr', '')).toThrow(GhError);
});
