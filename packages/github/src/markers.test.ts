import { expect, test } from 'vitest';
import { isReviewMarker, markBody, parseMarker, reviewMarker, threadMarker } from './markers.ts';

test('markers are invisible HTML comments naming the thread', () => {
  expect(threadMarker('t1')).toBe('<!-- vsdiff:t1 -->');
  expect(reviewMarker('9f2c1ab')).toBe('<!-- vsdiff:review:9f2c1ab -->');
});

test('marking and parsing round-trip a body verbatim', () => {
  const body = 'this retry loop can spin forever\n\n```ts\nwhile (true) {}\n```\n';

  const marked = markBody(threadMarker('tmt054el415'), body);

  expect(marked.startsWith('<!-- vsdiff:tmt054el415 -->\n')).toBe(true);
  expect(parseMarker(marked)).toEqual({ marker: 'tmt054el415', body });
});

test('an unmarked body is returned untouched', () => {
  expect(parseMarker('why drop the header?')).toEqual({
    marker: null,
    body: 'why drop the header?',
  });
});

test('only the marker line is stripped — other HTML comments survive', () => {
  const raw = '<!-- vsdiff:t2 -->\nsee <!-- not a marker --> below\n<!-- keep me -->';

  expect(parseMarker(raw)).toEqual({
    marker: 't2',
    body: 'see <!-- not a marker --> below\n<!-- keep me -->',
  });
});

test('a marker GitHub reflowed with spaces still parses', () => {
  expect(parseMarker('  <!--  vsdiff:t3  -->  \nbody').marker).toBe('t3');
  expect(parseMarker('\r\n<!-- vsdiff:t4 -->\r\nbody').marker).toBe('t4');
});

test('a marker below the first line is still found and removed', () => {
  expect(parseMarker('quoted reply\n<!-- vsdiff:t5 -->\nrest')).toEqual({
    marker: 't5',
    body: 'quoted reply\nrest',
  });
});

test('a marker-only body strips to nothing', () => {
  expect(parseMarker('<!-- vsdiff:t6 -->\n')).toEqual({ marker: 't6', body: '' });
});

test('review markers are told apart from thread markers', () => {
  expect(isReviewMarker('review:9f2c1ab')).toBe(true);
  expect(isReviewMarker('t1')).toBe(false);
});
