import { expect, test } from 'vitest';
import {
  ANCHOR_SIDES,
  getJsonSchema,
  HUNK_ID_PATTERN,
  SCHEMA_VERSION,
  SESSION_INTENTS,
  SESSION_SOURCE_TYPES,
  SEVERITIES,
  STOP_KINDS,
  STOP_TITLE_MAX,
} from './index.ts';

type Json = Record<string, unknown>;

const schema = (): Json => getJsonSchema() as Json;
const defs = (): Json => schema()['$defs'] as Json;
const def = (name: string): Json => defs()[name] as Json;
const props = (node: Json): Json => node['properties'] as Json;

test('is a draft 2020-12 document with a stable $id', () => {
  const doc = schema();
  expect(doc['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
  expect(doc['$id']).toBe('https://vsdiff.dev/schema/review-session.v1.json');
});

test('requires the same top-level fields as the permissive parser', () => {
  expect(schema()['required']).toEqual(['version', 'kind', 'title', 'source', 'chapters']);
  expect((props(schema())['version'] as Json)['const']).toBe(SCHEMA_VERSION);
});

test('returns a fresh copy each call so callers cannot mutate the module state', () => {
  const first = schema();
  delete first['$defs'];
  expect(schema()['$defs']).toBeTruthy();
});

test('every pattern in the schema compiles as a regular expression', () => {
  const patterns: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'pattern' && typeof value === 'string') patterns.push(value);
      else walk(value);
    }
  };
  walk(schema());
  expect(patterns.length).toBeGreaterThan(0);
  for (const pattern of patterns) {
    expect(() => new RegExp(pattern), pattern).not.toThrow();
  }
});

test('the hunk id pattern is the one the validator uses', () => {
  expect(def('hunkId')['pattern']).toBe(HUNK_ID_PATTERN);
});

test('the guide path pattern agrees with the validator on relative paths', () => {
  const pattern = new RegExp((props(def('guideRef'))['html'] as Json)['pattern'] as string);
  expect(pattern.test('guide/index.html')).toBe(true);
  expect(pattern.test('index.html')).toBe(true);
  expect(pattern.test('/etc/passwd')).toBe(false);
  expect(pattern.test('../outside.html')).toBe(false);
  expect(pattern.test('guide/../../outside.html')).toBe(false);
  expect(pattern.test('https://example.com/guide.html')).toBe(false);
  expect(pattern.test('C:\\guide.html')).toBe(false);
});

test('encodes the refs each source type needs', () => {
  const rules = def('sessionSource')['allOf'] as Json[];
  const required = rules.map((rule) => [
    (((rule['if'] as Json)['properties'] as Json)['type'] as Json)['const'],
    (rule['then'] as Json)['required'],
  ]);
  expect(required).toEqual([
    ['range', ['base', 'head']],
    ['commit', ['head']],
  ]);
});

test('enums match the TypeScript unions', () => {
  const stopProps = props(def('stop'));
  expect((stopProps['kind'] as Json)['enum']).toEqual(STOP_KINDS);
  expect((stopProps['severity'] as Json)['enum']).toEqual(SEVERITIES);
  expect((stopProps['title'] as Json)['maxLength']).toBe(STOP_TITLE_MAX);
  expect((props(def('sessionSource'))['type'] as Json)['enum']).toEqual(SESSION_SOURCE_TYPES);
  expect((props(def('anchor'))['side'] as Json)['enum']).toEqual(ANCHOR_SIDES);
  expect((props(schema())['intent'] as Json)['enum']).toEqual(SESSION_INTENTS);
});

test('keeps additionalProperties open at every object level', () => {
  const closed: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const record = node as Json;
    if (record['type'] === 'object' && record['additionalProperties'] !== true) {
      closed.push(path);
    }
    for (const [key, value] of Object.entries(record)) walk(value, `${path}.${key}`);
  };
  walk(schema(), '$');
  expect(closed).toEqual([]);
});

test('encodes the finding-only severity rule and the must-point-somewhere rule', () => {
  const [severityRule, anchoredRule] = def('stop')['allOf'] as Json[];
  expect(((severityRule as Json)['if'] as Json)['required']).toEqual(['severity']);
  expect((((severityRule as Json)['then'] as Json)['properties'] as Json)['kind']).toEqual({
    const: 'finding',
  });
  const branches = (anchoredRule as Json)['anyOf'] as Json[];
  expect(branches.map((branch) => branch['required'])).toEqual([['hunkIds'], ['anchors']]);
});
