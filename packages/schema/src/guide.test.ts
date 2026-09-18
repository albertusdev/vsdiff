// The authoring guide is a contract, not prose: if its example stops validating,
// every agent that copies it writes a broken session.

import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { validateSession } from './index.ts';

const guide = readFileSync(new URL('../guide.md', import.meta.url), 'utf8');

const jsonBlocks = (): string[] =>
  [...guide.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1] as string);

test('every fenced JSON block in the guide is valid JSON', () => {
  const blocks = jsonBlocks();
  expect(blocks.length).toBeGreaterThan(0);
  for (const block of blocks) {
    expect(() => JSON.parse(block), block.slice(0, 60)).not.toThrow();
  }
});

test('the example session passes the strict validator', () => {
  const sessions = jsonBlocks()
    .map((block) => JSON.parse(block) as Record<string, unknown>)
    .filter((doc) => doc['kind'] === 'review');
  expect(sessions).toHaveLength(1);
  const result = validateSession(sessions[0]);
  if (!result.ok) {
    throw new Error(`guide example is invalid: ${JSON.stringify(result.errors, null, 2)}`);
  }
});

test('documents the last-suffix rule for hunk ids', () => {
  expect(guide).toContain('a:h2b.ts:h1');
});

test('ends with the validate instruction', () => {
  const lines = guide.trimEnd().split('\n');
  expect(lines[lines.length - 1]).toBe(
    'Validate with `vsdiff validate <file>` and fix every reported issue before opening.',
  );
});
