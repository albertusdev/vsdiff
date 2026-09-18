import { expect, test } from 'vitest';
import { parseSession, SCHEMA_VERSION } from './index.ts';

const valid = JSON.stringify({
  version: SCHEMA_VERSION,
  kind: 'review',
  title: 'Test session',
  source: { type: 'range', base: 'main', head: 'HEAD' },
  chapters: [
    {
      id: 'c1',
      title: 'Core',
      stops: [{ id: 's1', prose: 'Start here.', hunkIds: ['src/a.ts:h1'] }],
    },
  ],
  'x-agent-extra': { preserved: true },
});

test('parses a valid session and preserves unknown fields', () => {
  const result = parseSession(valid);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.session.title).toBe('Test session');
    expect(result.session['x-agent-extra']).toEqual({ preserved: true });
  }
});

test('rejects malformed JSON with a readable error', () => {
  const result = parseSession('{nope');
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.errors[0]).toMatch(/not valid JSON/);
  }
});

test('reports every top-level shape error at once', () => {
  const result = parseSession(JSON.stringify({ version: 99, kind: 'nope' }));
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
  }
});
