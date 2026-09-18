// Hunk ids: `<path>:h<n>`, n being the 1-based position of the hunk in that
// file's patch within the diff the session's `source` defines (blueprint §6).
//
// Paths may themselves contain a `:h<digits>` sequence, so the LAST such suffix
// is the separator: `a:h2b.ts:h1` is hunk 1 of the file `a:h2b.ts`. The greedy
// `.+` below is what makes that true — keep it greedy.

/** Kept as a string so the JSON Schema `pattern` and the validator cannot drift. */
export const HUNK_ID_PATTERN = '^.+:h[1-9][0-9]*$';

const HUNK_ID_RE = new RegExp(HUNK_ID_PATTERN);

export interface ParsedHunkId {
  path: string;
  /** 1-based hunk ordinal within the file's patch. */
  n: number;
}

export function isHunkId(value: unknown): value is string {
  return typeof value === 'string' && HUNK_ID_RE.test(value);
}

/** Splits a hunk id at its last `:h<n>` suffix; `null` when it is malformed. */
export function parseHunkId(value: string): ParsedHunkId | null {
  if (!HUNK_ID_RE.test(value)) return null;
  const cut = value.lastIndexOf(':h');
  const path = value.slice(0, cut);
  const n = Number(value.slice(cut + 2));
  return { path, n };
}

export function formatHunkId(path: string, n: number): string {
  return `${path}:h${n}`;
}
