// Forward compatibility (D2): a session written by a newer agent must survive a
// load and a save byte-for-byte, not just at the top level. Neither read path may
// rebuild the objects it hands back.

import { expect, test } from 'vitest';
import { parseSession, validateSession } from './index.ts';

const raw = JSON.stringify(
  {
    version: 1,
    kind: 'review',
    title: 'Round trip',
    'x-top': { agent: 'claude', run: 7 },
    source: { type: 'range', base: 'main', head: 'HEAD', 'x-source': 'unknown to v1' },
    guide: { html: 'guide/index.html', 'x-guide': true },
    commit: { title: 'c', 'x-commit': 1 },
    pr: { number: 1, 'x-pr': 1 },
    chapters: [
      {
        id: 'c1',
        title: 'Core',
        priority: 'nice',
        'x-chapter': ['kept'],
        stops: [
          {
            id: 's1',
            priority: 'must',
            prose: 'Look here.',
            hunkIds: ['src/a.ts:h1'],
            'x-stop': { note: 'kept' },
            anchors: [{ path: 'src/a.ts', side: 'head', start: 1, end: 2, 'x-anchor': 'kept' }],
            suggestion: { patch: 'p', 'x-suggestion': 1 },
          },
        ],
      },
    ],
    support: [{ id: 'gen', reason: 'generated', hunkIds: ['lock:h1'], 'x-support': null }],
  },
  null,
  2,
);

test('parseSession preserves unknown fields at every level', () => {
  const result = parseSession(raw);
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  const session = result.session;
  expect(session['x-top']).toEqual({ agent: 'claude', run: 7 });
  expect(session.source['x-source']).toBe('unknown to v1');
  expect(session.guide?.['x-guide']).toBe(true);
  expect(session.commit?.['x-commit']).toBe(1);
  expect(session.pr?.['x-pr']).toBe(1);

  const chapter = session.chapters[0];
  expect(chapter?.['x-chapter']).toEqual(['kept']);
  expect(chapter?.priority).toBe('nice');
  const stop = chapter?.stops[0];
  expect(stop?.priority).toBe('must');
  expect(stop?.['x-stop']).toEqual({ note: 'kept' });
  expect(stop?.anchors?.[0]?.['x-anchor']).toBe('kept');
  expect(stop?.suggestion?.['x-suggestion']).toBe(1);
  expect(session.support?.[0]?.['x-support']).toBeNull();
});

test('validateSession hands back the same document, unknown fields included', () => {
  const result = validateSession(raw);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.session).toEqual(JSON.parse(raw));
});

test('a parsed session re-serializes byte-for-byte', () => {
  const result = parseSession(raw);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(JSON.stringify(result.session, null, 2)).toBe(raw);
});

test('validateSession accepts an already-parsed object and returns it unchanged', () => {
  const doc = JSON.parse(raw) as object;
  const result = validateSession(doc);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.session).toBe(doc);
});
