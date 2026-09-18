// Deterministic content generators for the fixture repos (blueprint §5).
// Every export here is a pure function of its arguments — no randomness, no
// clock — so repeated runs of make-fixture.mjs produce byte-identical repos.
//
// Two constraints shape the templates:
//   1. Every generated line embeds a path-derived slug, so cross-file line
//      overlap is near zero and git's rename detection can only pair the
//      renames we actually made, never a deleted file with a new one.
//   2. Every body block is exactly BLOCK_LINES long, so a change block can
//      replace one whole construct and leave plausible-looking code behind.

/** FNV-1a, 32-bit. Stable across Node versions (Math.imul is exact). */
export function hash32(input) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Seeded LCG: `next(max)` yields an integer in [0, max). */
export function counterFrom(seed) {
  let state = seed >>> 0;
  return (max) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % max;
  };
}

/** Deterministic lowercase hex of `length` chars, derived from `seed`. */
export function hexFrom(seed, length) {
  let h = hash32(seed);
  let out = '';
  while (out.length < length) {
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, length);
}

/** `src/payments/capture.ts` -> `paymentsCapture`; unique per path. */
export function slugOf(path) {
  const words = path
    .replace(/\.[^/]*$/, '')
    .replace(/^src\//, '')
    .split(/[/\-_.]/)
    .filter(Boolean);
  return words
    .map((word, index) => (index === 0 ? word : word[0].toUpperCase() + word.slice(1)))
    .join('');
}

export function pascalOf(slug) {
  return slug[0].toUpperCase() + slug.slice(1);
}

/** Target lines per file; block rounding keeps every source file in 40..200. */
export const MIN_LINES = 46;

export function lineTargetFor(path) {
  return MIN_LINES + (hash32(`${path}:size`) % 149);
}

/** Every body block — generated or replacement — is this many lines. */
export const BLOCK_LINES = 6;

const MODULE_HEADER_LINES = 14;
const TEXT_HEADER_LINES = 4;

const MODULE_BLOCKS = [
  ({ s, S }, n, k) => [
    `// ${s}: step ${n} scales the ${k}-slot weight for the caller.`,
    `export function ${s}Step${n}(input: ${S}Input): number {`,
    `  const ${s}Weight = ${k} + input.${s}Attempt;`,
    `  return ${s}Weight * ${(k % 7) + 2};`,
    `}`,
    ``,
  ],
  ({ s }, n, k) => [
    `export const ${s}Table${n} = {`,
    `  ${s}Key: '${s}-${n}',`,
    `  ${s}Weight: ${k},`,
    `  ${s}Retries: ${k % 5},`,
    `} as const;`,
    ``,
  ],
  ({ s, S }, n, k) => [
    `export async function ${s}Load${n}(id: string): Promise<${S}Result> {`,
    `  const ${s}Key = '${s}:${n}:' + id;`,
    `  const ${s}Weight = ${k} + id.length;`,
    `  return { ${s}Key, ${s}Weight, ${s}Ok: true };`,
    `}`,
    ``,
  ],
  ({ s }, n, k) => [
    `// ${s}: step ${n} keeps the ${k}-slot window aligned with the ledger.`,
    `export function ${s}Window${n}(values: number[]): number[] {`,
    `  const ${s}Span = Math.min(values.length, ${(k % 9) + 3});`,
    `  return values.slice(0, ${s}Span).map((value) => value + ${n});`,
    `}`,
    ``,
  ],
];

const TEST_BLOCKS = [
  ({ s }, n, k) => [
    `test('${s} case ${n} keeps the ${k}-slot budget', () => {`,
    `  const ${s}Value = ${k} * ${n};`,
    `  expect(${s}Value).toBe(${k * n});`,
    `  expect(${s}Value > 0).toBe(true);`,
    `});`,
    ``,
  ],
  ({ s }, n, k) => [
    `test('${s} case ${n} rejects an exhausted budget', () => {`,
    `  const ${s}Left = ${k} - ${n};`,
    `  expect(${s}Left).toBe(${k - n});`,
    `  expect(${s}Left > 0).toBe(${k - n > 0});`,
    `});`,
    ``,
  ],
];

const DOC_BLOCKS = [
  ({ title, s }, n, k) => [
    `## ${title} — section ${n}`,
    ``,
    `The ${s} flow retries at most ${(k % 9) + 2} times before the caller sees an error.`,
    `Each attempt carries the ${s} correlation id so the ledger stays traceable.`,
    `Budgets are counted per request, never per attempt.`,
    ``,
  ],
  ({ title, s }, n, k) => [
    `## ${title} — checklist ${n}`,
    ``,
    `- confirm the ${s} budget is ${(k % 9) + 2} attempts per request`,
    `- confirm the ${s} handler logs the correlation id on every retry`,
    `- confirm the ${s} ledger entry is written before the response`,
    ``,
  ],
];

/** Header + BLOCK_LINES-sized body blocks until `minLines` is reached. */
function build(header, blocks, context, seed, minLines) {
  const out = [...header];
  const next = counterFrom(seed);
  for (let n = 1; out.length < minLines; n += 1) {
    const block = blocks[next(blocks.length)];
    out.push(...block(context, n, next(97) + 3));
  }
  return out;
}

/** A .ts module: header + generated blocks until `minLines` is reached. */
export function moduleLines(path, minLines = lineTargetFor(path)) {
  const s = slugOf(path);
  const S = pascalOf(s);
  const header = [
    `// ${path}`,
    `// Deterministic fixture module — generated by scripts/make-fixture.mjs.`,
    ``,
    `export interface ${S}Input {`,
    `  ${s}Id: string;`,
    `  ${s}Attempt: number;`,
    `}`,
    ``,
    `export interface ${S}Result {`,
    `  ${s}Key: string;`,
    `  ${s}Weight: number;`,
    `  ${s}Ok: boolean;`,
    `}`,
    ``,
  ];
  return build(header, MODULE_BLOCKS, { s, S }, hash32(`${path}:body`), minLines);
}

/** A .test.ts file in the same shape, so tests churn like source files. */
export function testLines(path, minLines = lineTargetFor(path)) {
  const s = slugOf(path);
  const header = [
    `// ${path}`,
    `// Deterministic fixture test — generated by scripts/make-fixture.mjs.`,
    `import { expect, test } from 'vitest';`,
    ``,
  ];
  return build(header, TEST_BLOCKS, { s }, hash32(`${path}:body`), minLines);
}

/** A .md doc built from the same seeded machinery. */
export function docLines(path, minLines = lineTargetFor(path)) {
  const s = slugOf(path);
  const title = path
    .replace(/^docs\//, '')
    .replace(/\.md$/, '')
    .split('-')
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
  const header = [
    `# ${title}`,
    ``,
    `Deterministic fixture doc for the ${s} area — generated by make-fixture.mjs.`,
    ``,
  ];
  return build(header, DOC_BLOCKS, { title, s }, hash32(`${path}:body`), minLines);
}

/** Lines for any fixture path, chosen by extension. */
export function contentLines(path, minLines) {
  if (path.endsWith('.test.ts')) return testLines(path, minLines);
  if (path.endsWith('.md')) return docLines(path, minLines);
  return moduleLines(path, minLines);
}

/**
 * The replacement for one whole body block: BLOCK_LINES lines unique to
 * `path` + `tag`, so a block can never match its own surroundings.
 */
export function changeBlock(path, tag) {
  const s = slugOf(path);
  const S = pascalOf(s);
  if (path.endsWith('.md')) {
    return [
      `<!-- refactor(${tag}) -->`,
      ``,
      `Capture is now single-phase: ${s} callers build one \`CaptureContext\` and`,
      `share one retry budget per request instead of one budget per attempt.`,
      `The two-phase notes elsewhere in this doc are stale.`,
      ``,
    ];
  }
  if (path.endsWith('.test.ts')) {
    return [
      `test('${s} ${tag}: one retry budget per request', () => {`,
      `  const ${s}${tag} = captureContext({ retries: 2 });`,
      `  expect(${s}${tag}.retries.remaining).toBe(2);`,
      `  expect(${s}${tag}.idempotencyKey).not.toBe('');`,
      `});`,
      ``,
    ];
  }
  return [
    `// refactor(${tag}): rebuilt around the shared capture context.`,
    `export function ${s}${tag}(context: CaptureContext): ${S}Result {`,
    `  const ${s}Budget = context.retries.remaining;`,
    `  return { ${s}Key: context.idempotencyKey, ${s}Weight: ${s}Budget, ${s}Ok: true };`,
    `}`,
    ``,
  ];
}

/** Replace the whole block at `at` with `added`; returns a new array. */
export function applyBlock(lines, at, added) {
  return [...lines.slice(0, at), ...added, ...lines.slice(at + BLOCK_LINES)];
}

/**
 * The start offset of a whole body block, `fraction` of the way through the
 * file — so change blocks land on construct boundaries, not inside them.
 */
export function blockOffset(path, lines, fraction) {
  const isModule = path.endsWith('.ts') && !path.endsWith('.test.ts');
  const header = isModule ? MODULE_HEADER_LINES : TEXT_HEADER_LINES;
  const count = Math.floor((lines.length - header) / BLOCK_LINES);
  const index = Math.min(count - 1, Math.max(0, Math.floor(count * fraction)));
  return header + index * BLOCK_LINES;
}

/** Generated-lockfile lines; every line differs between versions. */
export function lockLines(count, version) {
  const out = [];
  for (let i = 1; i <= count; i += 1) {
    out.push(`entry-${String(i).padStart(5, '0')} sha512-${hexFrom(`lock:v${version}:${i}`, 64)}`);
  }
  return out;
}

/** ~200 deterministic bytes with a PNG signature + NULs, so git sees binary. */
export function fakePngBytes(version) {
  const header = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ];
  const bytes = Buffer.alloc(200);
  Buffer.from(header).copy(bytes, 0);
  for (let i = header.length; i < bytes.length; i += 1) {
    bytes[i] = (i * 7 + version * 61) & 0xff;
  }
  return bytes;
}
