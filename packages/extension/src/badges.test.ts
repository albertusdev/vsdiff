import { expect, test } from 'vitest';
import { chip, KIND_COLOR, kindColor, SEVERITY_COLOR, STATE_COLOR, stopChips } from './badges.ts';

// badges.ts is pure string work with no vscode import, so it tests headlessly.

const IMAGE = /!\[([^\]]*)]\(data:image\/svg\+xml,([^)]*)\)/g;

interface ParsedChip {
  alt: string;
  payload: string;
  svg: string;
}

function parseChips(markdown: string): ParsedChip[] {
  return [...markdown.matchAll(IMAGE)].map((match) => ({
    alt: match[1] ?? '',
    payload: match[2] ?? '',
    svg: decodeURIComponent(match[2] ?? ''),
  }));
}

function only(markdown: string): ParsedChip {
  const chips = parseChips(markdown);
  expect(chips).toHaveLength(1);
  // The whole string must be the image — a stray character would mean the
  // markdown link ended early.
  expect(`![${chips[0]?.alt}](data:image/svg+xml,${chips[0]?.payload})`).toBe(markdown);
  return chips[0] as ParsedChip;
}

test('chip renders a markdown image whose alt text is the label', () => {
  const { alt, svg } = only(chip('walkthrough', KIND_COLOR.walkthrough));
  expect(alt).toBe('walkthrough');
  expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
  expect(svg).toContain('>walkthrough</text>');
  expect(svg).toContain(`fill="${KIND_COLOR.walkthrough}"`);
  expect(svg).toContain('rx="4"');
  expect(svg).toContain('height="18"');
  expect(svg).toContain('fill="#ffffff"');
});

test('the payload is URL-encoded, with nothing that would end the markdown link', () => {
  const { payload, svg } = only(chip('a (b) & c', STATE_COLOR.neutral));
  expect(payload).not.toMatch(/[ <>#"()]/);
  expect(svg).toContain('a (b) &amp; c');
});

test('markup in the label is escaped rather than injected into the svg', () => {
  const { svg } = only(chip('<b>x</b>', STATE_COLOR.pending));
  expect(svg).toContain('&lt;b&gt;x&lt;/b&gt;');
  expect(svg.match(/<text/g)).toHaveLength(1);
});

test('width grows with the label and stays inside sane bounds', () => {
  const widthOf = (text: string): number =>
    Number(/width="(\d+)"/.exec(only(chip(text, STATE_COLOR.neutral)).svg)?.[1]);
  expect(widthOf('info')).toBeLessThan(widthOf('pending triage'));
  expect(widthOf('pending triage')).toBeLessThan(widthOf('pending triage on a longer label'));
  expect(widthOf('x')).toBeGreaterThanOrEqual(30);
  expect(widthOf('x'.repeat(200))).toBeLessThanOrEqual(260);
});

test('findings take their severity colour, other kinds their own', () => {
  expect(kindColor('finding', 'blocker')).toBe(SEVERITY_COLOR.blocker);
  expect(kindColor('finding', undefined)).toBe(KIND_COLOR.finding);
  expect(kindColor('verify', undefined)).toBe(KIND_COLOR.verify);
  expect(kindColor(undefined, undefined)).toBe(KIND_COLOR.walkthrough);
  // A severity on a non-finding stop is metadata, not a recolour.
  expect(kindColor('question', 'major')).toBe(KIND_COLOR.question);
});

test('stopChips carries kind, severity when set, and the position', () => {
  const plain = parseChips(stopChips('walkthrough', undefined, 'stop 1/8'));
  expect(plain.map((parsed) => parsed.alt)).toEqual(['walkthrough', 'stop 1/8']);
  expect(plain[1]?.svg).toContain(`fill="${STATE_COLOR.neutral}"`);

  const finding = parseChips(stopChips('finding', 'minor', 'stop 2/8'));
  expect(finding.map((parsed) => parsed.alt)).toEqual(['finding', 'minor', 'stop 2/8']);
  expect(finding[0]?.svg).toContain(`fill="${SEVERITY_COLOR.minor}"`);
  expect(finding[1]?.svg).toContain(`fill="${SEVERITY_COLOR.minor}"`);
});
