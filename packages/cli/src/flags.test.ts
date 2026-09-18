import { expect, test } from 'vitest';
import {
  numberFlag,
  parseFlags,
  requireIntFlag,
  requireStringFlag,
  stringFlag,
  UsageError,
} from './flags.ts';

test('parseFlags reads values, booleans and positionals', () => {
  const { flags, positional } = parseFlags([
    'session.json',
    '--thread',
    't1',
    '--json',
    '--body',
    'why not reuse the queue?',
  ]);

  expect(positional).toEqual(['session.json']);
  expect(flags.get('thread')).toBe('t1');
  expect(flags.get('json')).toBe(true);
  expect(stringFlag(flags, 'body')).toBe('why not reuse the queue?');
  expect(stringFlag(flags, 'json')).toBeUndefined();
  expect(stringFlag(flags, 'missing')).toBeUndefined();
});

test('a required flag with no value fails as usage, not as a crash', () => {
  const { flags } = parseFlags(['--thread', '--body', 'text']);

  expect(requireStringFlag(flags, 'body')).toBe('text');
  expect(() => requireStringFlag(flags, 'thread')).toThrow(UsageError);
  expect(() => requireStringFlag(flags, 'thread')).toThrow('missing --thread <value>');
  expect(() => requireStringFlag(flags, 'path')).toThrow('missing --path <value>');
});

test('numberFlag defaults, parses and rejects junk', () => {
  const { flags } = parseFlags(['--after', '12', '--timeout', 'soon', '--wait']);

  expect(numberFlag(flags, 'after', 0)).toBe(12);
  expect(numberFlag(flags, 'missing', 300)).toBe(300);
  expect(() => numberFlag(flags, 'timeout', 300)).toThrow(
    '--timeout must be a non-negative number',
  );
  expect(() => numberFlag(flags, 'wait', 0)).toThrow('missing value for --wait');
});

test('requireIntFlag takes 1-based lines only', () => {
  const { flags } = parseFlags(['--line', '54', '--zero', '0', '--frac', '1.5']);

  expect(requireIntFlag(flags, 'line')).toBe(54);
  expect(() => requireIntFlag(flags, 'zero')).toThrow('--zero must be a positive integer');
  expect(() => requireIntFlag(flags, 'frac')).toThrow('--frac must be a positive integer');
  expect(() => requireIntFlag(flags, 'missing')).toThrow('missing --missing <n>');
});
