// Reading gh's JSON. `gh api --paginate` emits ONE JSON array PER PAGE,
// concatenated with no wrapper (`[…][…]`), so a plain JSON.parse only ever sees
// the first page — the scanner below splits the stream on balanced brackets and
// merges the pages instead.

import { outputError } from './errors.ts';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** One JSON object — `gh <cmd> --json …`, or an `api` POST response. */
export function parseJsonObject(
  args: string[],
  context: string,
  raw: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw outputError(args, context, raw);
  }
  if (!isRecord(parsed)) throw outputError(args, context, raw);
  return parsed;
}

/** Index just past the JSON value starting at `start`, or -1 if it never closes. */
function endOfValue(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Every item of every page. Accepts one array, several concatenated arrays
 * (`--paginate`), a single wrapped array (`--slurp`), and bare objects one
 * after another (`-q '.[]'`) — all shapes a gh invocation can hand back.
 */
export function parseJsonPages(args: string[], context: string, raw: string): unknown[] {
  const items: unknown[] = [];
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && /\s/.test(raw[i] ?? '')) i += 1;
    if (i >= raw.length) break;
    const ch = raw[i];
    if (ch !== '[' && ch !== '{') throw outputError(args, context, raw.slice(i));
    const end = endOfValue(raw, i);
    if (end === -1) throw outputError(args, context, raw.slice(i));
    let page: unknown;
    try {
      page = JSON.parse(raw.slice(i, end));
    } catch {
      throw outputError(args, context, raw.slice(i, end));
    }
    if (Array.isArray(page)) items.push(...page);
    else items.push(page);
    i = end;
  }
  return items;
}
